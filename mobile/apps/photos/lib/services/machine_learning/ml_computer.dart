import 'dart:async';
import "dart:io" show Platform;
import "dart:typed_data" show Float32List, Uint8List;

import "package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart"
    show Uint64List;
import "package:logging/logging.dart";
import "package:photos/core/errors.dart";
import "package:photos/models/ml/vector.dart";
import "package:photos/service_locator.dart"
    show flagService, isLocalGalleryMode;
import "package:photos/services/machine_learning/ml_constants.dart";
import "package:photos/services/machine_learning/ml_model_download_service.dart";
import "package:photos/services/machine_learning/semantic_search/clip/clip_text_encoder.dart";
import "package:photos/services/machine_learning/semantic_search/query_result.dart";
import "package:photos/services/machine_learning/similar_images/similar_images_graph.dart";
import "package:photos/services/remote_assets_service.dart";
import "package:photos/utils/isolate/isolate_operations.dart";
import "package:photos/utils/isolate/super_isolate.dart";
import "package:synchronized/synchronized.dart";

@pragma('vm:entry-point')
class MLComputer extends SuperIsolate {
  @override
  Logger get logger => _logger;
  final _logger = Logger('MLComputer');

  final _initModelLock = Lock();
  bool _isClipTokenizerInitialized = false;
  String? _clipTextModelPath;
  String? _clipTextVocabPath;
  Future<void>? _clipTextWarmupFuture;

  @override
  bool get isDartUiIsolate => false;

  @override
  String get isolateName => "MLComputerIsolate";

  @override
  bool get shouldAutomaticDispose => false;

  bool get _shouldUseRustMl => flagService.useRustForML || isLocalGalleryMode;

  // Singleton pattern
  MLComputer._privateConstructor();
  static final MLComputer instance = MLComputer._privateConstructor();
  factory MLComputer() => instance;

  Future<(List<Uint64List>, List<Float32List>)> bulkVectorSearch(
    List<Float32List> clipFloat32,
    bool exact,
  ) async {
    try {
      final result = await runInIsolate(IsolateOperation.bulkVectorSearch, {
        "clipFloat32": clipFloat32,
        "exact": exact,
      });
      return result;
    } catch (e, s) {
      _logger.severe("Could not run bulk vector search in MLComputer", e, s);
      rethrow;
    }
  }

  /// Finds candidate near-duplicate pairs among [potentialKeys] via a CLIP
  /// nearest-neighbour search followed by mutual-kNN + threshold filtering,
  /// entirely inside the isolate (see [Note: similar images grouping]).
  /// Returns three aligned lists describing each candidate edge.
  Future<(List<int>, List<int>, List<double>)> findSimilarImageCandidateEdges({
    required Uint64List potentialKeys,
    required bool exact,
    required double distanceThreshold,
    required int mutualRankK,
    required Map<int, List<String>> personIdsByFileId,
  }) async {
    try {
      final result =
          await runInIsolate(
                IsolateOperation.findSimilarImageCandidateEdges,
                {
                  "potentialKeys": potentialKeys,
                  "exact": exact,
                  "distanceThreshold": distanceThreshold,
                  "mutualRankK": mutualRankK,
                  "personIdsByFileId": personIdsByFileId,
                },
              )
              as Map;
      return (
        List<int>.from(result["edgeFileIdA"] as List),
        List<int>.from(result["edgeFileIdB"] as List),
        List<double>.from(result["edgeDistance"] as List),
      );
    } catch (e, s) {
      _logger.severe("Could not find similar image candidate edges", e, s);
      rethrow;
    }
  }

  /// Verifies candidate near-duplicate edges against a rotation-aware
  /// perceptual hash of each file's thumbnail, then groups the surviving
  /// edges into connected components, entirely inside the isolate.
  Future<List<SimilarFilesGroupResult>> verifyAndClusterSimilarImages({
    required List<int> edgeFileIdA,
    required List<int> edgeFileIdB,
    required List<double> edgeDistance,
    required Map<int, Uint8List> thumbnailBytesByFileId,
    required int maxHammingDistance,
  }) async {
    try {
      final result =
          await runInIsolate(IsolateOperation.verifyAndClusterSimilarImages, {
                "edgeFileIdA": edgeFileIdA,
                "edgeFileIdB": edgeFileIdB,
                "edgeDistance": edgeDistance,
                "thumbnailBytesByFileId": thumbnailBytesByFileId,
                "maxHammingDistance": maxHammingDistance,
              })
              as List;
      return [
        for (final raw in result)
          SimilarFilesGroupResult(
            List<int>.from((raw as Map)["fileIds"] as List),
            (raw["furthestDistance"] as num).toDouble(),
          ),
      ];
    } catch (e, s) {
      _logger.severe("Could not verify and cluster similar images", e, s);
      rethrow;
    }
  }

  Future<List<double>> runClipText(String query) async {
    try {
      final useRustMl = _shouldUseRustMl;
      await _ensureLoadedClipTextModel(useRustMl);
      final modelPath = _clipTextModelPath;
      final vocabPath = _clipTextVocabPath;
      if (useRustMl && (modelPath == null || modelPath.trim().isEmpty)) {
        throw Exception(
          "RustMLMissingModelPath: Missing required model path: clipTextModelPath",
        );
      }
      if (useRustMl && (vocabPath == null || vocabPath.trim().isEmpty)) {
        throw Exception(
          "RustMLMissingModelPath: Missing required model path: clipTextVocabPath",
        );
      }
      final isolateResult = await runInIsolate(IsolateOperation.runClipText, {
        "text": query,
        "useRustMl": useRustMl,
        if (useRustMl) ...{
          "clipTextModelPath": modelPath,
          "clipTextVocabPath": vocabPath,
          "preferCoreml": Platform.isIOS,
          "preferNnapi": Platform.isAndroid,
          "preferXnnpack": Platform.isAndroid,
          "allowCpuFallback": true,
        } else ...{
          "address": ClipTextEncoder.instance.sessionAddress,
        },
      });
      if (isolateResult is RustCorruptModelCacheDeletedException) {
        _clipTextModelPath = null;
        MLModelDownloadService.instance.invalidateModelDownloadCache(
          includeNonIndexingModels: true,
        );
        throw isolateResult;
      }
      final textEmbedding = isolateResult as List<double>;
      return textEmbedding;
    } on WiFiUnavailableError catch (e, s) {
      _logger.warning(
        "Could not run clip text because model is unavailable",
        e,
        s,
      );
      rethrow;
    } on RustCorruptModelCacheDeletedException catch (e) {
      _logger.warning(
        "Deleted corrupt Rust CLIP text model cache at ${e.modelPath}",
      );
      rethrow;
    } catch (e, s) {
      _logger.severe("Could not run clip text in isolate", e, s);
      rethrow;
    }
  }

  Future<void> warmUpClipTextEncoder() {
    _clipTextWarmupFuture ??= _warmUpClipTextEncoderInternal();
    return _clipTextWarmupFuture!;
  }

  Future<void> _warmUpClipTextEncoderInternal() async {
    try {
      await runClipText("warm up text encoder");
    } catch (e, s) {
      _clipTextWarmupFuture = null;
      _logger.warning("Clip text warmup failed in MLComputer", e, s);
      rethrow;
    }
  }

  Future<void> _ensureLoadedClipTextModel(bool useRustMl) async {
    return _initModelLock.synchronized(() async {
      try {
        if (_clipTextVocabPath == null) {
          final tokenizerRemotePath = ClipTextEncoder.instance.vocabRemotePath;
          _clipTextVocabPath = await RemoteAssetsService.instance.getAssetPath(
            tokenizerRemotePath,
            expectedSha256: ClipTextEncoder.instance.vocabSha256,
          );
        }

        if (useRustMl &&
            _clipTextVocabPath != null &&
            _clipTextModelPath != null) {
          return;
        }

        if (!useRustMl &&
            _isClipTokenizerInitialized &&
            ClipTextEncoder.instance.isInitialized) {
          return;
        }

        if (!useRustMl && !_isClipTokenizerInitialized) {
          await runInIsolate(IsolateOperation.initializeClipTokenizer, {
            'vocabPath': _clipTextVocabPath!,
          });
          _isClipTokenizerInitialized = true;
        }

        final String? downloadedModelPath = await ClipTextEncoder.instance
            .downloadModelSafe();
        if (downloadedModelPath == null) {
          throw WiFiUnavailableError(
            "Could not download clip text model because high bandwidth "
            "connectivity is unavailable",
          );
        }
        _clipTextModelPath = downloadedModelPath;

        if (useRustMl || ClipTextEncoder.instance.isInitialized) {
          return;
        }

        final String modelName = ClipTextEncoder.instance.modelName;
        final address =
            await runInIsolate(IsolateOperation.loadModel, {
                  'modelName': modelName,
                  'modelPath': downloadedModelPath,
                })
                as int;
        ClipTextEncoder.instance.storeSessionAddress(address);
      } catch (e, s) {
        _logger.severe("Could not load clip text model in MLComputer", e, s);
        rethrow;
      }
    });
  }

  Future<Map<String, List<QueryResult>>> computeBulkSimilarities(
    Map<String, List<double>> textQueryToEmbeddingMap,
    Map<String, double> minimumSimilarityMap,
  ) async {
    try {
      final queryToResults =
          await runInIsolate(IsolateOperation.computeBulkSimilarities, {
                "textQueryToEmbeddingMap": textQueryToEmbeddingMap,
                "minimumSimilarityMap": minimumSimilarityMap,
              })
              as Map<String, List<QueryResult>>;
      return queryToResults;
    } catch (e, s) {
      _logger.severe(
        "Could not bulk compare embeddings inside MLComputer isolate",
        e,
        s,
      );
      rethrow;
    }
  }

  Future<Map<String, List<QueryResult>>> computeBulkSimilaritiesWithRust(
    Map<String, List<double>> textQueryToEmbeddingMap,
    Map<String, double> minimumSimilarityMap,
  ) async {
    try {
      final queryToResults =
          await runInIsolate(IsolateOperation.computeBulkSimilaritiesWithRust, {
                "textQueryToEmbeddingMap": textQueryToEmbeddingMap,
                "minimumSimilarityMap": minimumSimilarityMap,
              })
              as Map<String, List<QueryResult>>;
      return queryToResults;
    } catch (e, s) {
      _logger.severe(
        "Could not bulk compare embeddings with rust inside MLComputer isolate",
        e,
        s,
      );
      rethrow;
    }
  }

  Future<void> cacheImageEmbeddings(
    List<EmbeddingVector> embeddings, {
    bool cacheRustExact = false,
  }) async {
    try {
      await runInIsolate(IsolateOperation.cacheImageEmbeddings, {
            'embeddings': embeddings,
            'cacheRustExact': cacheRustExact,
          })
          as bool;
      _logger.info(
        'Cached ${embeddings.length} image embeddings inside MLComputer',
      );
      return;
    } catch (e, s) {
      _logger.severe("Could not cache image embeddings in MLComputer", e, s);
      rethrow;
    }
  }

  Future<void> clearImageEmbeddingsCache() async {
    try {
      await runInIsolate(IsolateOperation.clearIsolateCache, {
            'key': imageEmbeddingsKey,
          })
          as bool;
      return;
    } catch (e, s) {
      _logger.severe(
        "Could not clear image embeddings cache in MLComputer",
        e,
        s,
      );
      rethrow;
    }
  }
}
