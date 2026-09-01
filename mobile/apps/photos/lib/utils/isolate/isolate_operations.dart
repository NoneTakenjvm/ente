import 'dart:io' show File;
import 'dart:typed_data' show Float32List, Uint8List;

import "package:flutter_rust_bridge/flutter_rust_bridge.dart" show Uint64List;
import "package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart"
    show Int64List;
import "package:ml_linalg/linalg.dart";
import "package:photos/db/ml/clip_vector_db.dart";
import "package:photos/models/ml/face/box.dart";
import "package:photos/models/ml/vector.dart";
import "package:photos/services/machine_learning/face_ml/face_clustering/face_clustering_service.dart";
import "package:photos/services/machine_learning/ml_constants.dart";
import "package:photos/services/machine_learning/ml_model.dart";
import "package:photos/services/machine_learning/ml_result.dart";
import "package:photos/services/machine_learning/semantic_search/clip/clip_text_encoder.dart";
import "package:photos/services/machine_learning/semantic_search/clip/clip_text_tokenizer.dart";
import "package:photos/services/machine_learning/semantic_search/query_result.dart";
import "package:photos/services/machine_learning/similar_images/similar_images_graph.dart";
import "package:photos/src/rust/api/image_processing_api.dart"
    as rust_image_processing;
import "package:photos/src/rust/api/ml_indexing_api.dart" as rust_ml;
import "package:photos/src/rust/api/usearch_api.dart" as rust_usearch;
import "package:photos/src/rust/frb_generated.dart" show EntePhotosRust;
import "package:photos/utils/image_ml_util.dart";
import "package:photos/utils/ml_util.dart";
import "package:photos/utils/similar_images/perceptual_hash.dart";

final Map<String, dynamic> _isolateCache = {};
const _rustLibLoadedCacheKey = "rustLibLoaded";
const _rustMlRuntimeConfigCacheKey = "rustMlRuntimeConfig";

class RustCorruptModelCacheDeletedException implements Exception {
  const RustCorruptModelCacheDeletedException(this.modelPath);

  final String modelPath;

  @override
  String toString() => "RustCorruptModelCacheDeletedException: $modelPath";
}

enum IsolateOperation {
  /// [MLIndexingIsolate]
  analyzeImage,

  /// [MLIndexingIsolate]
  prepareRustMlRuntime,

  /// [MLIndexingIsolate]
  releaseRustMlRuntime,

  /// [MLIndexingIsolate]
  loadIndexingModels,

  /// [MLIndexingIsolate]
  releaseIndexingModels,

  /// [MLComputer]
  generateFaceThumbnails,

  /// [MLComputer]
  loadModel,

  /// [MLComputer]
  initializeClipTokenizer,

  /// [MLComputer]
  runClipText,

  /// [MLComputer]
  computeBulkSimilarities,

  /// [MLComputer]
  computeBulkSimilaritiesWithRust,

  /// [MLComputer]
  bulkVectorSearch,

  /// [MLComputer]
  findSimilarImageCandidateEdges,

  /// [MLComputer]
  verifyAndClusterSimilarImages,

  /// [FaceClusteringService]
  linearIncrementalClustering,

  /// Cache operations
  cacheImageEmbeddings,
  setIsolateCache,
  clearIsolateCache,
  clearAllIsolateCache,
}

class _CachedImageEmbeddings {
  _CachedImageEmbeddings({required this.embeddingVectors});

  final List<EmbeddingVector> embeddingVectors;
  rust_usearch.SemanticSearchExactCache? rustExactCache;
}

/// WARNING: Only return primitives unless you know the method is only going
/// to be used on regular isolates as opposed to DartUI and Flutter isolates
///  https://api.flutter.dev/flutter/dart-isolate/SendPort/send.html
Future<dynamic> isolateFunction(
  IsolateOperation function,
  Map<String, dynamic> args,
) async {
  switch (function) {
    case IsolateOperation.bulkVectorSearch:
      await _ensureRustLoaded();
      final clipFloat32 = args["clipFloat32"] as List<Float32List>;
      final exact = args["exact"] as bool;

      return ClipVectorDB.instance.bulkSearchVectors(
        clipFloat32,
        BigInt.from(100),
        exact: exact,
      );

    case IsolateOperation.findSimilarImageCandidateEdges:
      await _ensureRustLoaded();
      final potentialKeys = args["potentialKeys"] as Uint64List;
      final exact = args["exact"] as bool;
      final distanceThreshold = args["distanceThreshold"] as double;
      final mutualRankK = args["mutualRankK"] as int;
      final personIdsByFileId = (args["personIdsByFileId"] as Map)
          .map<int, Set<String>>(
            (key, value) =>
                MapEntry(key as int, Set<String>.from(value as List)),
          );

      final (keys, vectorKeys, distances) = await ClipVectorDB.instance
          .bulkSearchWithKeys(potentialKeys, BigInt.from(100), exact: exact);

      final knnEntries = <KnnEntry>[
        for (int i = 0; i < keys.length; i++)
          KnnEntry(
            fileId: keys[i].toInt(),
            neighborIds: vectorKeys[i]
                .map((key) => key.toInt())
                .toList(growable: false),
            neighborDistances: distances[i]
                .map((distance) => distance.toDouble())
                .toList(growable: false),
          ),
      ];

      final edges = findMutualCandidateEdges(
        knnEntries: knnEntries,
        distanceThreshold: distanceThreshold,
        mutualRankK: mutualRankK,
        extraConstraint: personIdsByFileId.isEmpty
            ? null
            : (fileIdA, fileIdB) => _samePersonIds(
                personIdsByFileId,
                fileIdA,
                fileIdB,
              ),
      );

      return {
        "edgeFileIdA": [for (final edge in edges) edge.fileIdA],
        "edgeFileIdB": [for (final edge in edges) edge.fileIdB],
        "edgeDistance": [for (final edge in edges) edge.distance],
      };

    case IsolateOperation.verifyAndClusterSimilarImages:
      final edgeFileIdA = args["edgeFileIdA"] as List<int>;
      final edgeFileIdB = args["edgeFileIdB"] as List<int>;
      final edgeDistance = args["edgeDistance"] as List<double>;
      final thumbnailBytesByFileId =
          args["thumbnailBytesByFileId"] as Map<int, Uint8List>;
      final maxHammingDistance = args["maxHammingDistance"] as int;

      final candidateEdges = <CandidateEdge>[
        for (int i = 0; i < edgeFileIdA.length; i++)
          CandidateEdge(edgeFileIdA[i], edgeFileIdB[i], edgeDistance[i]),
      ];

      final rotationHashesByFileId = <int, List<int>>{};
      for (final entry in thumbnailBytesByFileId.entries) {
        final hashes = dHashForAllRotations(entry.value);
        if (hashes.isNotEmpty) {
          rotationHashesByFileId[entry.key] = hashes;
        }
      }

      final verifiedEdges = filterEdgesByPerceptualHash(
        candidateEdges: candidateEdges,
        rotationHashesByFileId: rotationHashesByFileId,
        maxHammingDistance: maxHammingDistance,
      );

      final groups = groupConnectedComponents(verifiedEdges);
      return [
        for (final group in groups)
          {
            "fileIds": group.fileIds,
            "furthestDistance": group.furthestDistance,
          },
      ];

    /// Cases for MLIndexingIsolate start here

    /// MLIndexingIsolate
    case IsolateOperation.analyzeImage:
      final bool useRustMl = args["useRustMl"] as bool? ?? false;
      if (useRustMl) {
        await _ensureRustLoaded();
      }
      final MLResult result;
      try {
        result = useRustMl
            ? await analyzeImageRust(args)
            : await analyzeImageStatic(args);
      } on rust_ml.RustMlError_CorruptModel catch (e) {
        final file = File(e.field0);
        if (await file.exists()) {
          await file.delete();
        }
        return RustCorruptModelCacheDeletedException(e.field0);
      }
      return result.toJsonString();

    /// MLIndexingIsolate
    case IsolateOperation.prepareRustMlRuntime:
      await _ensureRustLoaded();
      await _ensureRustRuntimePrepared(args);
      return true;

    /// MLIndexingIsolate
    case IsolateOperation.releaseRustMlRuntime:
      await _releaseRustRuntime();
      return true;

    /// MLIndexingIsolate
    case IsolateOperation.loadIndexingModels:
      final modelNames = args['modelNames'] as List<String>;
      final modelPaths = args['modelPaths'] as List<String>;
      final addresses = <int>[];
      for (int i = 0; i < modelNames.length; i++) {
        final int address = await MlModel.loadModel(
          modelNames[i],
          modelPaths[i],
        );
        addresses.add(address);
      }
      return List<int>.from(addresses, growable: false);

    /// MLIndexingIsolate
    case IsolateOperation.releaseIndexingModels:
      final modelNames = args['modelNames'] as List<String>;
      final modelAddresses = args['modelAddresses'] as List<int>;
      for (int i = 0; i < modelNames.length; i++) {
        await MlModel.releaseModel(modelNames[i], modelAddresses[i]);
      }
      return true;

    /// Cases for MLIndexingIsolate stop here

    /// Cases for MLComputer start here

    /// MLComputer
    case IsolateOperation.generateFaceThumbnails:
      final imagePath = args['imagePath'] as String;
      final useRustForFaceThumbnails =
          args['useRustForFaceThumbnails'] as bool? ?? false;
      final faceBoxesJson = args['faceBoxesList'] as List<Map<String, dynamic>>;
      final List<FaceBox> faceBoxes = faceBoxesJson
          .map((json) => FaceBox.fromJson(json))
          .toList();
      if (useRustForFaceThumbnails) {
        await _ensureRustLoaded();
        final rustFaceBoxes = faceBoxes
            .map(
              (box) => rust_image_processing.RustFaceBox(
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
              ),
            )
            .toList(growable: false);
        final List<Uint8List> results = await rust_image_processing
            .generateFaceThumbnails(
              imagePath: imagePath,
              faceBoxes: rustFaceBoxes,
            );
        return List.from(results);
      }
      final List<Uint8List> results = await generateFaceThumbnailsUsingCanvas(
        imagePath,
        faceBoxes,
      );
      return List.from(results);

    /// MLComputer
    case IsolateOperation.loadModel:
      final modelName = args['modelName'] as String;
      final modelPath = args['modelPath'] as String;
      final int address = await MlModel.loadModel(modelName, modelPath);
      return address;

    /// MLComputer
    case IsolateOperation.initializeClipTokenizer:
      final vocabPath = args["vocabPath"] as String;
      await ClipTextTokenizer.instance.init(vocabPath);
      return true;

    /// MLComputer
    case IsolateOperation.runClipText:
      final useRustMl = args["useRustMl"] as bool? ?? false;
      if (!useRustMl) {
        final textEmbedding = await ClipTextEncoder.predict(args);
        return List<double>.from(textEmbedding, growable: false);
      }

      await _ensureRustLoaded();
      final text = args["text"] as String;
      final clipTextModelPath = args["clipTextModelPath"] as String?;
      if (clipTextModelPath == null || clipTextModelPath.trim().isEmpty) {
        throw Exception(
          "RustMLMissingModelPath: Missing required model path: clipTextModelPath",
        );
      }

      final clipTextVocabPath = args["clipTextVocabPath"] as String?;
      if (clipTextVocabPath == null || clipTextVocabPath.trim().isEmpty) {
        throw Exception(
          "RustMLMissingModelPath: Missing required model path: clipTextVocabPath",
        );
      }

      final rust_ml.RunClipTextResult result;
      try {
        result = await rust_ml.runClipTextRust(
          req: rust_ml.RunClipTextRequest(
            text: text,
            modelPath: clipTextModelPath,
            vocabPath: clipTextVocabPath,
            providerPolicy: rust_ml.RustExecutionProviderPolicy(
              preferCoreml: args["preferCoreml"] as bool? ?? true,
              preferNnapi: args["preferNnapi"] as bool? ?? true,
              preferXnnpack: args["preferXnnpack"] as bool? ?? false,
              allowCpuFallback: args["allowCpuFallback"] as bool? ?? true,
            ),
          ),
        );
      } on rust_ml.RustMlError_CorruptModel catch (e) {
        final file = File(e.field0);
        if (await file.exists()) {
          await file.delete();
        }
        return RustCorruptModelCacheDeletedException(e.field0);
      }
      return List<double>.from(result.embedding, growable: false);

    /// MLComputer
    case IsolateOperation.computeBulkSimilarities:
      final cachedEmbeddings = _getCachedImageEmbeddings();
      final textEmbedding =
          args["textQueryToEmbeddingMap"] as Map<String, List<double>>;
      final minimumSimilarityMap =
          args["minimumSimilarityMap"] as Map<String, double>;
      final result = <String, List<QueryResult>>{};
      for (final MapEntry<String, List<double>> entry
          in textEmbedding.entries) {
        final query = entry.key;
        final textVector = Vector.fromList(entry.value);
        final minimumSimilarity = minimumSimilarityMap[query]!;
        final queryResults = <QueryResult>[];
        for (final imageEmbedding in cachedEmbeddings.embeddingVectors) {
          final similarity = imageEmbedding.vector.dot(textVector);
          if (similarity >= minimumSimilarity) {
            queryResults.add(QueryResult(imageEmbedding.fileID, similarity));
          }
        }
        queryResults.sort(
          (first, second) => second.score.compareTo(first.score),
        );
        result[query] = queryResults;
      }
      return result;

    /// MLComputer
    case IsolateOperation.computeBulkSimilaritiesWithRust:
      await _ensureRustLoaded();
      final cachedEmbeddings = _getCachedImageEmbeddings();
      final textEmbedding =
          args["textQueryToEmbeddingMap"] as Map<String, List<double>>;
      final minimumSimilarityMap =
          args["minimumSimilarityMap"] as Map<String, double>;
      final queryKeys = textEmbedding.keys.toList(growable: false);
      final rustExactCache = await _ensureRustExactCache(cachedEmbeddings);
      final response = await rustExactCache.search(
        queryEmbeddings: queryKeys
            .map((query) => Float32List.fromList(textEmbedding[query]!))
            .toList(growable: false),
        minimumSimilarities: Float32List.fromList(
          queryKeys
              .map((query) => minimumSimilarityMap[query]!)
              .toList(growable: false),
        ),
      );
      final result = <String, List<QueryResult>>{};
      for (int i = 0; i < queryKeys.length; i++) {
        final matches = response.matchesPerQuery[i];
        result[queryKeys[i]] = matches
            .map((match) => QueryResult(match.fileId, match.score))
            .toList(growable: false);
      }
      return result;

    /// Cases for MLComputer end here

    /// Cases for FaceClusteringService start here

    /// FaceClusteringService
    case IsolateOperation.linearIncrementalClustering:
      final ClusteringResult result = runLinearClustering(args);
      return result;

    /// Cases for FaceClusteringService end here

    /// Cases for Caching start here

    /// Caching
    case IsolateOperation.cacheImageEmbeddings:
      final embeddings = args['embeddings'] as List<EmbeddingVector>;
      final cacheRustExact = args['cacheRustExact'] as bool? ?? false;
      final cachedEmbeddings = _CachedImageEmbeddings(
        embeddingVectors: embeddings,
      );
      if (cacheRustExact) {
        cachedEmbeddings.rustExactCache = await _createRustExactCache(
          cachedEmbeddings,
        );
      }
      _disposeIsolateCacheValue(_isolateCache[imageEmbeddingsKey]);
      _isolateCache[imageEmbeddingsKey] = cachedEmbeddings;
      return true;

    /// Caching
    case IsolateOperation.setIsolateCache:
      final key = args['key'] as String;
      final value = args['value'];
      _disposeIsolateCacheValue(_isolateCache[key]);
      _isolateCache[key] = value;
      return true;

    /// Caching
    case IsolateOperation.clearIsolateCache:
      final key = args['key'] as String;
      final removedValue = _isolateCache.remove(key);
      _disposeIsolateCacheValue(removedValue);
      return true;

    /// Caching
    case IsolateOperation.clearAllIsolateCache:
      await _ensureRustDisposed();
      for (final value in _isolateCache.values) {
        _disposeIsolateCacheValue(value);
      }
      _isolateCache.clear();
      return true;

    /// Cases for Caching stop here
  }
}

/// Two files are only grouped as similar if they carry the exact same set of
/// identified people, so e.g. a landscape shot doesn't get grouped with a
/// portrait purely because CLIP thinks they look alike. Files with no entry
/// in [personIdsByFileId] are treated as having no identified people.
bool _samePersonIds(
  Map<int, Set<String>> personIdsByFileId,
  int fileIdA,
  int fileIdB,
) {
  final personsA = personIdsByFileId[fileIdA] ?? const <String>{};
  final personsB = personIdsByFileId[fileIdB] ?? const <String>{};
  return personsA.length == personsB.length && personsA.containsAll(personsB);
}

_CachedImageEmbeddings _getCachedImageEmbeddings() {
  final cachedEmbeddings = _isolateCache[imageEmbeddingsKey];
  if (cachedEmbeddings is! _CachedImageEmbeddings) {
    throw StateError("Image embeddings are not cached in MLComputer isolate");
  }
  return cachedEmbeddings;
}

Future<rust_usearch.SemanticSearchExactCache> _ensureRustExactCache(
  _CachedImageEmbeddings cachedEmbeddings,
) async {
  final rustExactCache = cachedEmbeddings.rustExactCache;
  if (rustExactCache != null && !rustExactCache.isDisposed) {
    return rustExactCache;
  }

  final newCache = await _createRustExactCache(cachedEmbeddings);
  cachedEmbeddings.rustExactCache = newCache;
  return newCache;
}

Future<rust_usearch.SemanticSearchExactCache> _createRustExactCache(
  _CachedImageEmbeddings cachedEmbeddings,
) async {
  await _ensureRustLoaded();
  final imageFileIds = Int64List.fromList(
    cachedEmbeddings.embeddingVectors
        .map((embedding) => embedding.fileID)
        .toList(growable: false),
  );
  final imageEmbeddings = cachedEmbeddings.embeddingVectors
      .map((embedding) => Float32List.fromList(embedding.vector.toList()))
      .toList(growable: false);
  return rust_usearch.SemanticSearchExactCache(
    imageFileIds: imageFileIds,
    imageEmbeddings: imageEmbeddings,
  );
}

void _disposeIsolateCacheValue(dynamic value) {
  if (value is _CachedImageEmbeddings) {
    value.rustExactCache?.dispose();
    value.rustExactCache = null;
  }
}

Future<void> _ensureRustLoaded() async {
  final bool loaded = _isolateCache[_rustLibLoadedCacheKey] as bool? ?? false;
  if (!loaded) {
    await EntePhotosRust.init();
    _isolateCache[_rustLibLoadedCacheKey] = true;
  }
}

Future<void> _ensureRustDisposed() async {
  // Intentionally a no-op.
  //
  // Rust ML residency is owned by the feature isolate that prepared it.
  // The generic cache-clear path runs in multiple rust-using isolates, so
  // letting it call process-global ML teardown would allow unrelated isolates
  // to release indexing sessions they do not own. MLIndexingIsolate tracks
  // whether it prepared the runtime and releases it explicitly during its own
  // cleanup, even if the app mode or flags have changed since preparation.
}

Future<void> _ensureRustRuntimePrepared(Map<String, dynamic> args) async {
  final modelPaths = rust_ml.RustModelPaths(
    faceDetection: (args["faceDetectionModelPath"] as String?) ?? "",
    faceEmbedding: (args["faceEmbeddingModelPath"] as String?) ?? "",
    clipImage: (args["clipImageModelPath"] as String?) ?? "",
    clipText: (args["clipTextModelPath"] as String?) ?? "",
    petFaceDetection: (args["petFaceDetectionModelPath"] as String?) ?? "",
    petFaceEmbeddingDog:
        (args["petFaceEmbeddingDogModelPath"] as String?) ?? "",
    petFaceEmbeddingCat:
        (args["petFaceEmbeddingCatModelPath"] as String?) ?? "",
    petBodyDetection: (args["petBodyDetectionModelPath"] as String?) ?? "",
    petBodyEmbeddingDog:
        (args["petBodyEmbeddingDogModelPath"] as String?) ?? "",
    petBodyEmbeddingCat:
        (args["petBodyEmbeddingCatModelPath"] as String?) ?? "",
  );
  final providerPolicy = rust_ml.RustExecutionProviderPolicy(
    preferCoreml: args["preferCoreml"] as bool? ?? true,
    preferNnapi: args["preferNnapi"] as bool? ?? true,
    preferXnnpack: args["preferXnnpack"] as bool? ?? false,
    allowCpuFallback: args["allowCpuFallback"] as bool? ?? true,
  );
  final runtimeConfigKey = _runtimeConfigCacheKey(modelPaths, providerPolicy);
  final currentConfigKey =
      _isolateCache[_rustMlRuntimeConfigCacheKey] as String?;
  if (currentConfigKey == runtimeConfigKey) {
    return;
  }

  final missingModelPaths = <String>[];
  if (modelPaths.faceDetection.trim().isEmpty) {
    missingModelPaths.add("faceDetectionModelPath");
  }
  if (modelPaths.faceEmbedding.trim().isEmpty) {
    missingModelPaths.add("faceEmbeddingModelPath");
  }
  if (modelPaths.clipImage.trim().isEmpty) {
    missingModelPaths.add("clipImageModelPath");
  }
  if (missingModelPaths.isNotEmpty) {
    throw Exception(
      "RustMLMissingModelPath: Missing required model paths: ${missingModelPaths.join(', ')}",
    );
  }

  await rust_ml.initMlRuntime(
    config: rust_ml.RustMlRuntimeConfig(
      modelPaths: modelPaths,
      providerPolicy: providerPolicy,
    ),
  );
  _isolateCache[_rustMlRuntimeConfigCacheKey] = runtimeConfigKey;
}

Future<void> _releaseRustRuntime() async {
  final bool loaded = _isolateCache[_rustLibLoadedCacheKey] as bool? ?? false;
  if (!loaded) {
    return;
  }
  try {
    await rust_ml.releaseMlRuntime();
  } catch (_) {
    // no-op: indexing-model release is best-effort.
  }
  _isolateCache.remove(_rustMlRuntimeConfigCacheKey);
}

String _runtimeConfigCacheKey(
  rust_ml.RustModelPaths modelPaths,
  rust_ml.RustExecutionProviderPolicy providerPolicy,
) {
  return [
    modelPaths.faceDetection,
    modelPaths.faceEmbedding,
    modelPaths.clipImage,
    modelPaths.clipText,
    modelPaths.petFaceDetection,
    modelPaths.petFaceEmbeddingDog,
    modelPaths.petFaceEmbeddingCat,
    modelPaths.petBodyDetection,
    modelPaths.petBodyEmbeddingDog,
    modelPaths.petBodyEmbeddingCat,
    providerPolicy.preferCoreml,
    providerPolicy.preferNnapi,
    providerPolicy.preferXnnpack,
    providerPolicy.allowCpuFallback,
  ].join("|");
}
