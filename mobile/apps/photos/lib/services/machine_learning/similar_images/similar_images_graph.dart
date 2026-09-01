/// Pure, isolate-safe grouping logic for the similar-images feature.
///
/// [Note: similar images grouping]
/// The previous implementation picked an arbitrary "root" file and pulled in
/// every one of its top-100 CLIP neighbours within a distance threshold,
/// marking them all used. A single file that happened to sit in a dense
/// region of embedding space (e.g. many differently-shot photos of the same
/// whiteboard/receipt/product) could pull in hundreds of unrelated files
/// into one group.
///
/// This module instead only connects two files when they are mutual
/// nearest neighbours (both consider the other one of their closest matches)
/// and unions them via a proper connected-components pass, so a group only
/// grows through a chain of genuinely close pairs rather than everything
/// within range of a single root.
library;

import "package:photos/utils/similar_images/perceptual_hash.dart"
    show hammingDistance;

class KnnEntry {
  /// The file this entry describes.
  final int fileId;

  /// Neighbour file IDs, sorted ascending by [neighborDistances].
  final List<int> neighborIds;

  /// Distances aligned with [neighborIds].
  final List<double> neighborDistances;

  const KnnEntry({
    required this.fileId,
    required this.neighborIds,
    required this.neighborDistances,
  });
}

class CandidateEdge {
  final int fileIdA;
  final int fileIdB;
  final double distance;

  const CandidateEdge(this.fileIdA, this.fileIdB, this.distance);

  @override
  String toString() => "CandidateEdge($fileIdA, $fileIdB, $distance)";
}

/// Finds candidate near-duplicate pairs from nearest-neighbour search
/// results. An edge is only produced when [fileIdA] and [fileIdB] are within
/// [distanceThreshold] of each other AND each is among the other's closest
/// [mutualRankK] neighbours, which is what stops a single densely-clustered
/// file from chaining together an oversized, unrelated group.
///
/// [extraConstraint], if given, is an additional required condition (e.g.
/// "both files are tagged with the same identified people") evaluated on
/// every otherwise-eligible pair.
List<CandidateEdge> findMutualCandidateEdges({
  required List<KnnEntry> knnEntries,
  required double distanceThreshold,
  required int mutualRankK,
  bool Function(int fileIdA, int fileIdB)? extraConstraint,
}) {
  final topKNeighborsById = <int, Set<int>>{};
  for (final entry in knnEntries) {
    topKNeighborsById[entry.fileId] = entry.neighborIds
        .take(mutualRankK)
        .toSet();
  }

  final edges = <CandidateEdge>[];
  for (final entry in knnEntries) {
    // Only consider this file's own top-mutualRankK neighbours: a true
    // mutual-nearest-neighbour edge requires each file to be among the
    // other's closest matches, not merely within the distance threshold.
    final ownCandidateCount = entry.neighborIds.length < mutualRankK
        ? entry.neighborIds.length
        : mutualRankK;
    for (int i = 0; i < ownCandidateCount; i++) {
      final distance = entry.neighborDistances[i];
      if (distance > distanceThreshold) {
        // neighborDistances is sorted ascending, nothing further qualifies
        break;
      }
      final otherId = entry.neighborIds[i];
      if (otherId == entry.fileId) continue;
      // Only emit each pair once.
      if (otherId <= entry.fileId) continue;

      final otherIsCloseToThis = topKNeighborsById[otherId]?.contains(
            entry.fileId,
          ) ??
          false;
      if (!otherIsCloseToThis) continue;

      if (extraConstraint != null &&
          !extraConstraint(entry.fileId, otherId)) {
        continue;
      }

      edges.add(CandidateEdge(entry.fileId, otherId, distance));
    }
  }
  return edges;
}

/// Simple union-find with path compression, keyed by file ID.
class UnionFind {
  final Map<int, int> _parent = {};

  int find(int x) {
    var root = _parent.putIfAbsent(x, () => x);
    while (root != x) {
      x = root;
      root = _parent.putIfAbsent(x, () => x);
    }
    // Path compression: point every visited node directly at the root.
    root = _parent[x]!;
    var current = x;
    while (_parent[current] != root) {
      final next = _parent[current]!;
      _parent[current] = root;
      current = next;
    }
    return root;
  }

  void union(int a, int b) {
    final rootA = find(a);
    final rootB = find(b);
    if (rootA != rootB) {
      _parent[rootA] = rootB;
    }
  }
}

class SimilarFilesGroupResult {
  final List<int> fileIds;
  final double furthestDistance;

  const SimilarFilesGroupResult(this.fileIds, this.furthestDistance);
}

/// Groups [edges] into connected components via union-find and returns only
/// the groups with more than one file, each paired with the largest edge
/// distance found within that group (used by the UI's close/similar/related
/// filter, mirroring the previous "furthestDistance" semantics).
List<SimilarFilesGroupResult> groupConnectedComponents(
  List<CandidateEdge> edges,
) {
  final unionFind = UnionFind();
  for (final edge in edges) {
    unionFind.union(edge.fileIdA, edge.fileIdB);
  }

  final fileIdsByRoot = <int, Set<int>>{};
  final furthestDistanceByRoot = <int, double>{};
  for (final edge in edges) {
    final root = unionFind.find(edge.fileIdA);
    fileIdsByRoot.putIfAbsent(root, () => {}).addAll([
      edge.fileIdA,
      edge.fileIdB,
    ]);
    final currentFurthest = furthestDistanceByRoot[root] ?? 0.0;
    if (edge.distance > currentFurthest) {
      furthestDistanceByRoot[root] = edge.distance;
    }
  }

  return fileIdsByRoot.entries
      .where((entry) => entry.value.length > 1)
      .map(
        (entry) => SimilarFilesGroupResult(
          entry.value.toList(),
          furthestDistanceByRoot[entry.key] ?? 0.0,
        ),
      )
      .toList();
}

/// Drops candidate edges that fail perceptual-hash verification, i.e. the
/// two files don't actually look structurally alike once you look past the
/// CLIP embedding. An edge is kept only if a rotation-hash is known for both
/// files and the best rotation match is within [maxHammingDistance] (out of
/// 64 bits). Edges for files with no known hash (e.g. the thumbnail could
/// not be decoded) are dropped rather than trusted blindly.
List<CandidateEdge> filterEdgesByPerceptualHash({
  required List<CandidateEdge> candidateEdges,
  required Map<int, List<int>> rotationHashesByFileId,
  required int maxHammingDistance,
}) {
  final verified = <CandidateEdge>[];
  for (final edge in candidateEdges) {
    final hashesA = rotationHashesByFileId[edge.fileIdA];
    final hashesB = rotationHashesByFileId[edge.fileIdB];
    if (hashesA == null || hashesA.isEmpty || hashesB == null || hashesB.isEmpty) {
      continue;
    }
    int bestDistance = 64;
    for (final hashA in hashesA) {
      for (final hashB in hashesB) {
        final distance = hammingDistance(hashA, hashB);
        if (distance < bestDistance) {
          bestDistance = distance;
        }
      }
    }
    if (bestDistance <= maxHammingDistance) {
      verified.add(edge);
    }
  }
  return verified;
}
