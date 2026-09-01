import "dart:io" show File;
import "dart:math" show max, min;
import "dart:typed_data" show Uint8List;

import "package:ente_pure_utils/ente_pure_utils.dart";
import "package:flutter/foundation.dart" show kDebugMode;
import "package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart"
    show Uint64List;
import 'package:logging/logging.dart';
import "package:path_provider/path_provider.dart";
import "package:photos/db/ml/db.dart";
import "package:photos/models/file/extensions/file_props.dart";
import 'package:photos/models/file/file.dart';
import "package:photos/models/similar_files.dart";
import "package:photos/services/favorites_service.dart";
import "package:photos/services/machine_learning/ml_computer.dart";
import "package:photos/services/machine_learning/ml_result.dart";
import "package:photos/services/search_service.dart";
import "package:photos/utils/cache_util.dart";
import "package:photos/utils/thumbnail_util.dart" show getThumbnail;

class SimilarImagesService {
  static const double _groupedClipEmbeddingLossRefreshRatio = 0.05;

  /// A candidate pair only becomes an edge if each file is among the
  /// other's closest [_mutualRankK] CLIP neighbours (see
  /// [Note: similar images grouping] in similar_images_graph.dart).
  static const int _mutualRankK = 10;

  /// Maximum allowed Hamming distance (out of 64 bits) between perceptual
  /// hashes for a CLIP-flagged pair to be treated as a genuine near-duplicate.
  static const int _maxHammingDistance = 8;

  /// How many thumbnails to fetch/decode at a time while reporting
  /// progress, so a large candidate set never blocks the UI in one go.
  static const int _thumbnailFetchBatchSize = 40;

  final _logger = Logger("SimilarImagesService");

  SimilarImagesService._privateConstructor();
  static final SimilarImagesService instance =
      SimilarImagesService._privateConstructor();

  /// Returns a list of SimilarFiles, where each SimilarFiles object contains
  /// a list of files that are perceptually similar
  Future<List<SimilarFiles>> getSimilarFiles(
    double distanceThreshold, {
    bool exact = false,
    bool forceRefresh = false,
    SimilarImagesProgressCallback? onProgress,
  }) async {
    try {
      final now = DateTime.now();
      final List<SimilarFiles> result = await _getSimilarFiles(
        distanceThreshold,
        exact,
        forceRefresh,
        onProgress,
      );
      final duration = DateTime.now().difference(now);
      _logger.info(
        "Found ${result.length} similar files in ${duration.inSeconds} seconds for threshold $distanceThreshold and exact $exact",
      );
      return result;
    } catch (e, s) {
      _logger.severe("failed to get similar files", e, s);
      rethrow;
    }
  }

  Future<List<SimilarFiles>> _getSimilarFiles(
    double distanceThreshold,
    bool exact,
    bool forceRefresh,
    SimilarImagesProgressCallback? onProgress,
  ) async {
    final w = (kDebugMode ? EnteWatch('getSimilarFiles') : null)?..start();
    final mlDataDB = MLDataDB.instance;
    _logger.info("Checking migration and filling clip vector DB");
    await mlDataDB.checkMigrateFillClipVectorDB();
    w?.log("checkMigrateFillClipVectorDB");

    // Get all files with CLIP embeddings first to avoid caching unindexed files
    final Map<int, int> clipIndexedFiles = await mlDataDB
        .clipIndexedFileWithVersion();
    final Set<int> clipIndexedFileIDs = clipIndexedFiles.keys.toSet();
    w?.log("getClipIndexedFiles");

    // Get all files, and all potential embedding IDs, and create a map of fileID to file
    final allFiles = Set<EnteFile>.from(
      await SearchService.instance.getAllFilesForSearch(),
    );
    final allFileIdsToFile = <int, EnteFile>{};
    final fileIDs = <int>[];
    for (final file in allFiles) {
      if (file.uploadedFileID != null &&
          file.isOwner &&
          !file.isVideo &&
          clipIndexedFileIDs.contains(file.uploadedFileID!)) {
        allFileIdsToFile[file.uploadedFileID!] = file;
        fileIDs.add(file.uploadedFileID!);
      }
    }
    final Uint64List potentialKeys = Uint64List.fromList(fileIDs);
    w?.log("getAllFilesForSearch");

    // Get mapping of fileIDs to corresponding personIDs
    final fileIDToPersonIDs = <int, Set<String>>{};
    final dbPersonClusterInfo = await mlDataDB.getPersonToClusterIdToFaceIds();
    for (final personID in dbPersonClusterInfo.keys) {
      final clusterInfo = dbPersonClusterInfo[personID]!;
      for (final faceIDs in clusterInfo.values) {
        for (final faceID in faceIDs) {
          final fileID = getFileIdFromFaceId<int>(faceID);
          if (allFileIdsToFile.containsKey(fileID)) {
            fileIDToPersonIDs
                .putIfAbsent(fileID, () => <String>{})
                .add(personID);
          }
        }
      }
    }
    w?.log("getFileIDToPersonIDs");

    if (forceRefresh) {
      final result = await _performFullSearch(
        potentialKeys,
        allFileIdsToFile,
        fileIDToPersonIDs,
        distanceThreshold,
        exact,
        onProgress,
      );
      await _cacheSimilarFiles(
        result,
        fileIDs.toSet(),
        distanceThreshold,
        exact,
        DateTime.now().millisecondsSinceEpoch,
      );
      return result;
    }

    // Load cached data
    final SimilarFilesCache? cachedData = await _readCachedSimilarFiles();
    if (cachedData == null) {
      _logger.warning("No cached similar files found");
    } else {
      _logger.info(
        "Cached similar files found with ${cachedData.similarFilesJsonStringList.length} groups",
      );
    }

    // Determine if we need full refresh
    bool needsFullRefresh = false;
    if (cachedData != null) {
      final Set<int> cachedFileIDs = cachedData.allCheckedFileIDs;
      final currentFileIDs = fileIDs.toSet();

      if (cachedData.distanceThreshold != distanceThreshold ||
          cachedData.exact != exact) {
        needsFullRefresh = true;
      }

      // Check condition: less than 1000 files
      if (currentFileIDs.length < 1000) {
        needsFullRefresh = true;
      }

      // Check condition: cache is older than a month
      if (DateTime.fromMillisecondsSinceEpoch(
        cachedData.cachedTime,
      ).isBefore(DateTime.now().subtract(const Duration(days: 30)))) {
        needsFullRefresh = true;
      }

      // Check condition: new files > 20% of total files
      if (!needsFullRefresh) {
        final newFileIDs = currentFileIDs.difference(cachedFileIDs);
        if (newFileIDs.length > currentFileIDs.length * 0.2) {
          needsFullRefresh = true;
        }
      }

      // Check condition: 20+% of grouped files deleted
      if (!needsFullRefresh) {
        final Set<int> cacheGroupedFileIDs = await cachedData
            .getGroupedFileIDs();
        final deletedFromGroups = cacheGroupedFileIDs.intersection(
          cachedFileIDs.difference(currentFileIDs),
        );
        final totalInGroups = cacheGroupedFileIDs.length;
        if (totalInGroups > 0 &&
            deletedFromGroups.length > totalInGroups * 0.2) {
          needsFullRefresh = true;
        }

        if (!needsFullRefresh && totalInGroups > 0) {
          final groupedFilesWithoutClipEmbeddings = cacheGroupedFileIDs
              .difference(clipIndexedFileIDs);
          if (groupedFilesWithoutClipEmbeddings.length >
              totalInGroups * _groupedClipEmbeddingLossRefreshRatio) {
            _logger.info(
              "Refreshing similar images cache because ${groupedFilesWithoutClipEmbeddings.length} of $totalInGroups grouped files no longer have CLIP embeddings",
            );
            needsFullRefresh = true;
          }
        }
      }
    }

    if (cachedData == null || needsFullRefresh) {
      final result = await _performFullSearch(
        potentialKeys,
        allFileIdsToFile,
        fileIDToPersonIDs,
        distanceThreshold,
        exact,
        onProgress,
      );
      await _cacheSimilarFiles(
        result,
        fileIDs.toSet(),
        distanceThreshold,
        exact,
        DateTime.now().millisecondsSinceEpoch,
      );
      return result;
    } else {
      return await _performIncrementalUpdate(
        cachedData,
        potentialKeys,
        allFileIdsToFile,
        fileIDToPersonIDs,
        distanceThreshold,
        exact,
        onProgress,
      );
    }
  }

  Future<List<SimilarFiles>> _performIncrementalUpdate(
    SimilarFilesCache cachedData,
    Uint64List currentFileIDs,
    Map<int, EnteFile> allFileIdsToFile,
    Map<int, Set<String>> fileIDToPersonIDs,
    double distanceThreshold,
    bool exact,
    SimilarImagesProgressCallback? onProgress,
  ) async {
    _logger.info("Performing incremental update for similar files");
    final existingGroups = await cachedData.similarFilesList();
    final cachedFileIDs = cachedData.allCheckedFileIDs;
    final currentFileIDsSet = currentFileIDs.map((id) => id.toInt()).toSet();
    final deletedFiles = cachedFileIDs.difference(currentFileIDsSet);

    // Clean up deleted files from existing groups
    if (deletedFiles.isNotEmpty) {
      for (final group in existingGroups) {
        final filesInGroupToDelete = [];
        for (final fileInGroup in group.files) {
          if (deletedFiles.contains(fileInGroup.uploadedFileID ?? -1)) {
            filesInGroupToDelete.add(fileInGroup);
          }
        }
        for (final fileToDelete in filesInGroupToDelete) {
          group.removeFile(fileToDelete);
        }
      }
    }
    // Remove empty groups
    existingGroups.removeWhere((group) => group.length <= 1);

    // Identify new files
    final newFileIDs = currentFileIDsSet.difference(cachedFileIDs);
    if (newFileIDs.isEmpty) {
      if (deletedFiles.isNotEmpty) {
        await _cacheSimilarFiles(
          existingGroups,
          currentFileIDsSet,
          distanceThreshold,
          exact,
          cachedData.cachedTime,
        );
      }
      return existingGroups;
    }

    // Re-run the candidate+verify pipeline scoped to the new files plus
    // whichever files are already grouped, so a new file can either join an
    // existing group or form a new one alongside other new files.
    final existingGroupedFileIds = <int>{};
    for (final group in existingGroups) {
      existingGroupedFileIds.addAll(group.fileIds);
    }
    final scopedFileIds = <int>{...newFileIDs, ...existingGroupedFileIds};
    final freshGroups = await _findAndVerifySimilarGroups(
      Uint64List.fromList(scopedFileIds.toList()),
      allFileIdsToFile,
      fileIDToPersonIDs,
      distanceThreshold,
      exact,
      onProgress,
    );

    for (final freshGroup in freshGroups) {
      SimilarFiles? matchedExisting;
      for (final existing in existingGroups) {
        if (existing.fileIds.intersection(freshGroup.fileIds).isNotEmpty) {
          matchedExisting = existing;
          break;
        }
      }
      if (matchedExisting == null) {
        existingGroups.add(freshGroup);
        continue;
      }
      for (final file in freshGroup.files) {
        if (!matchedExisting.containsFile(file)) {
          matchedExisting.addFile(file);
        }
      }
      matchedExisting.furthestDistance = max(
        matchedExisting.furthestDistance,
        freshGroup.furthestDistance,
      );
      _sortGroupFiles(matchedExisting.files);
    }

    await _cacheSimilarFiles(
      existingGroups,
      currentFileIDsSet,
      distanceThreshold,
      exact,
      cachedData.cachedTime,
    );

    return existingGroups;
  }

  Future<List<SimilarFiles>> _performFullSearch(
    Uint64List potentialKeys,
    Map<int, EnteFile> allFileIdsToFile,
    Map<int, Set<String>> fileIDToPersonIDs,
    double distanceThreshold,
    bool exact,
    SimilarImagesProgressCallback? onProgress,
  ) async {
    _logger.info("Performing full search for similar files");
    return _findAndVerifySimilarGroups(
      potentialKeys,
      allFileIdsToFile,
      fileIDToPersonIDs,
      distanceThreshold,
      exact,
      onProgress,
    );
  }

  /// The shared pipeline behind both a full search and an incremental
  /// update: find CLIP-based mutual-nearest-neighbour candidates, verify
  /// each candidate against a perceptual hash of its thumbnail (see
  /// [Note: similar images grouping] in similar_images_graph.dart), then
  /// group the verified pairs. All of the CPU-heavy work runs inside an
  /// isolate; only the (already-cached-locally) thumbnail reads happen on
  /// the caller's isolate, and those are async and chunked so the UI never
  /// blocks for long.
  Future<List<SimilarFiles>> _findAndVerifySimilarGroups(
    Uint64List potentialKeys,
    Map<int, EnteFile> allFileIdsToFile,
    Map<int, Set<String>> fileIDToPersonIDs,
    double distanceThreshold,
    bool exact,
    SimilarImagesProgressCallback? onProgress,
  ) async {
    if (potentialKeys.isEmpty) return [];
    final w = (kDebugMode ? EnteWatch('getSimilarFiles') : null)?..start();

    onProgress?.call(
      const SimilarImagesProgress(
        stepDescription: "Comparing photos",
        completed: 0,
        total: 1,
      ),
    );
    final personIdsByFileId = <int, List<String>>{
      for (final entry in fileIDToPersonIDs.entries)
        if (entry.value.isNotEmpty) entry.key: entry.value.toList(),
    };
    final (edgeFileIdA, edgeFileIdB, edgeDistance) = await MLComputer.instance
        .findSimilarImageCandidateEdges(
          potentialKeys: potentialKeys,
          exact: exact,
          distanceThreshold: distanceThreshold,
          mutualRankK: _mutualRankK,
          personIdsByFileId: personIdsByFileId,
        );
    w?.log("findSimilarImageCandidateEdges");
    onProgress?.call(
      const SimilarImagesProgress(
        stepDescription: "Comparing photos",
        completed: 1,
        total: 1,
      ),
    );

    if (edgeFileIdA.isEmpty) return [];

    final candidateFileIds = <int>{...edgeFileIdA, ...edgeFileIdB};
    final thumbnailBytesByFileId = await _fetchThumbnails(
      candidateFileIds,
      allFileIdsToFile,
      onProgress,
    );
    w?.log("fetchThumbnails");

    final groupResults = await MLComputer.instance.verifyAndClusterSimilarImages(
      edgeFileIdA: edgeFileIdA,
      edgeFileIdB: edgeFileIdB,
      edgeDistance: edgeDistance,
      thumbnailBytesByFileId: thumbnailBytesByFileId,
      maxHammingDistance: _maxHammingDistance,
    );
    w?.log("verifyAndClusterSimilarImages");

    final result = <SimilarFiles>[];
    for (final groupResult in groupResults) {
      final files = <EnteFile>[
        for (final fileId in groupResult.fileIds)
          if (allFileIdsToFile[fileId] != null) allFileIdsToFile[fileId]!,
      ];
      if (files.length <= 1) continue;
      _sortGroupFiles(files);
      result.add(SimilarFiles(files, groupResult.furthestDistance));
    }
    return result;
  }

  /// Fetches (and, if needed, decrypts) the thumbnail bytes for each file in
  /// [fileIds] in small batches, reporting progress after every batch.
  Future<Map<int, Uint8List>> _fetchThumbnails(
    Set<int> fileIds,
    Map<int, EnteFile> allFileIdsToFile,
    SimilarImagesProgressCallback? onProgress,
  ) async {
    final thumbnailBytesByFileId = <int, Uint8List>{};
    final fileIdList = fileIds.toList();
    int completed = 0;
    for (int i = 0; i < fileIdList.length; i += _thumbnailFetchBatchSize) {
      final batch = fileIdList.sublist(
        i,
        min(i + _thumbnailFetchBatchSize, fileIdList.length),
      );
      final batchBytes = await Future.wait(
        batch.map((fileId) async {
          final file = allFileIdsToFile[fileId];
          if (file == null) return null;
          try {
            return await getThumbnail(file);
          } catch (e) {
            _logger.warning(
              "Could not load thumbnail for similar images verification: $fileId",
              e,
            );
            return null;
          }
        }),
      );
      for (int j = 0; j < batch.length; j++) {
        final bytes = batchBytes[j];
        if (bytes != null) {
          thumbnailBytesByFileId[batch[j]] = bytes;
        }
      }
      completed += batch.length;
      onProgress?.call(
        SimilarImagesProgress(
          stepDescription: "Verifying matches",
          completed: completed,
          total: fileIdList.length,
        ),
      );
    }
    return thumbnailBytesByFileId;
  }

  void _sortGroupFiles(List<EnteFile> files) {
    files.sort((a, b) {
      if (FavoritesService.instance.isFavoriteCache(a)) {
        return -1;
      } else if (FavoritesService.instance.isFavoriteCache(b)) {
        return 1;
      }
      final sizeComparison = (b.fileSize ?? 0).compareTo(a.fileSize ?? 0);
      if (sizeComparison != 0) return sizeComparison;
      return a.displayName.compareTo(b.displayName);
    });
  }

  Future<String> _getCachePath() async {
    return (await getApplicationSupportDirectory()).path +
        "/cache/similar_images_cache";
  }

  Future<void> _cacheSimilarFiles(
    List<SimilarFiles> similarGroups,
    Set<int> allCheckedFileIDs,
    double distanceThreshold,
    bool exact,
    int cachedTimeOfOriginalComputation,
  ) async {
    final cachePath = await _getCachePath();
    final similarGroupsJsonStringList = similarGroups
        .map((group) => group.toJsonString())
        .toList();
    final cacheObject = SimilarFilesCache(
      similarFilesJsonStringList: similarGroupsJsonStringList,
      allCheckedFileIDs: allCheckedFileIDs,
      distanceThreshold: distanceThreshold,
      exact: exact,
      cachedTime: cachedTimeOfOriginalComputation,
    );
    await writeToJsonFile<SimilarFilesCache>(
      cachePath,
      cacheObject,
      SimilarFilesCache.encodeToJsonString,
    );
  }

  Future<SimilarFilesCache?> _readCachedSimilarFiles() async {
    _logger.info("Reading similar files cache result from disk");
    final cache = decodeJsonFile<SimilarFilesCache>(
      await _getCachePath(),
      SimilarFilesCache.decodeFromJsonString,
    );
    return cache;
  }

  Future<void> clearCache() async {
    try {
      final cachePath = await _getCachePath();
      final file = File(cachePath);
      if (await file.exists()) {
        await file.delete();
        _logger.info("Cleared similar files cache at $cachePath");
      }
    } catch (e, s) {
      _logger.severe("Error clearing similar files cache", e, s);
      rethrow;
    }
  }
}
