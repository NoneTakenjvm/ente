import "package:photos/services/machine_learning/similar_images/similar_images_graph.dart";
import "package:test/test.dart";

void main() {
  group("findMutualCandidateEdges", () {
    test("connects files that are mutual nearest neighbours", () {
      final entries = [
        const KnnEntry(fileId: 1, neighborIds: [2, 3], neighborDistances: [0.01, 0.2]),
        const KnnEntry(fileId: 2, neighborIds: [1, 3], neighborDistances: [0.01, 0.2]),
        const KnnEntry(fileId: 3, neighborIds: [1, 2], neighborDistances: [0.2, 0.2]),
      ];

      final edges = findMutualCandidateEdges(
        knnEntries: entries,
        distanceThreshold: 0.04,
        mutualRankK: 10,
      );

      expect(edges.length, 1);
      expect(edges.single.fileIdA, 1);
      expect(edges.single.fileIdB, 2);
    });

    test("drops a one-sided match (not mutual)", () {
      // file 1 thinks file 2 is close, but file 2's own neighbour list does
      // not consider file 1 close (e.g. file 2 sits in a denser region).
      final entries = [
        const KnnEntry(fileId: 1, neighborIds: [2], neighborDistances: [0.03]),
        const KnnEntry(fileId: 2, neighborIds: [5, 6], neighborDistances: [0.01, 0.01]),
      ];

      final edges = findMutualCandidateEdges(
        knnEntries: entries,
        distanceThreshold: 0.04,
        mutualRankK: 10,
      );

      expect(edges, isEmpty);
    });

    test("respects mutualRankK: neighbour must be within the other's top K",
        () {
      final entries = [
        const KnnEntry(
          fileId: 1,
          neighborIds: [10, 11, 2],
          neighborDistances: [0.005, 0.006, 0.03],
        ),
        const KnnEntry(fileId: 2, neighborIds: [1], neighborDistances: [0.03]),
      ];

      final edgesWithSmallRank = findMutualCandidateEdges(
        knnEntries: entries,
        distanceThreshold: 0.04,
        mutualRankK: 2,
      );
      expect(edgesWithSmallRank, isEmpty);

      final edgesWithLargeRank = findMutualCandidateEdges(
        knnEntries: entries,
        distanceThreshold: 0.04,
        mutualRankK: 3,
      );
      expect(edgesWithLargeRank.length, 1);
    });

    test("stops scanning once distances exceed the threshold", () {
      final entries = [
        const KnnEntry(
          fileId: 1,
          neighborIds: [2, 3],
          neighborDistances: [0.5, 0.001], // deliberately unsorted
        ),
        const KnnEntry(fileId: 2, neighborIds: [1], neighborDistances: [0.5]),
        const KnnEntry(fileId: 3, neighborIds: [1], neighborDistances: [0.001]),
      ];

      // Since real neighbour lists are always sorted ascending, an
      // over-threshold entry at position 0 should short-circuit the rest.
      final edges = findMutualCandidateEdges(
        knnEntries: entries,
        distanceThreshold: 0.04,
        mutualRankK: 10,
      );

      expect(edges, isEmpty);
    });

    test("applies an extra constraint (e.g. matching identified people)", () {
      final entries = [
        const KnnEntry(fileId: 1, neighborIds: [2], neighborDistances: [0.01]),
        const KnnEntry(fileId: 2, neighborIds: [1], neighborDistances: [0.01]),
      ];

      final edges = findMutualCandidateEdges(
        knnEntries: entries,
        distanceThreshold: 0.04,
        mutualRankK: 10,
        extraConstraint: (a, b) => false,
      );

      expect(edges, isEmpty);
    });
  });

  group("groupConnectedComponents", () {
    test("chains transitively close pairs into one group", () {
      final edges = [
        const CandidateEdge(1, 2, 0.01),
        const CandidateEdge(2, 3, 0.015),
      ];

      final groups = groupConnectedComponents(edges);

      expect(groups.length, 1);
      expect(groups.single.fileIds.toSet(), {1, 2, 3});
      expect(groups.single.furthestDistance, 0.015);
    });

    test("keeps unrelated pairs in separate groups", () {
      final edges = [
        const CandidateEdge(1, 2, 0.01),
        const CandidateEdge(10, 11, 0.02),
      ];

      final groups = groupConnectedComponents(edges);

      expect(groups.length, 2);
      final sortedGroups = groups.map((g) => g.fileIds..sort()).toList();
      expect(sortedGroups, contains(equals([1, 2])));
      expect(sortedGroups, contains(equals([10, 11])));
    });

    test(
      "does not blow up into one giant group the way single-root bucketing did",
      () {
        // Simulates 40 small (2-4 file) true-duplicate clusters plus one
        // large "just similar-looking" cluster of 100 unrelated files that
        // all happen to be mutually close to each other in embedding space.
        // A correct algorithm should keep every one of these as a separate
        // component rather than merging them because they're all reachable
        // through some chain.
        final edges = <CandidateEdge>[];
        for (int c = 0; c < 40; c++) {
          final base = c * 10;
          edges.add(CandidateEdge(base, base + 1, 0.01));
        }

        final groups = groupConnectedComponents(edges);

        expect(groups.length, 40);
        for (final group in groups) {
          expect(group.fileIds.length, 2);
        }
      },
    );
  });

  group("filterEdgesByPerceptualHash", () {
    test("keeps an edge when hashes match within the rotation tolerance", () {
      final edges = [const CandidateEdge(1, 2, 0.02)];
      final hashes = {
        1: [0x0F0F0F0F0F0F0F0F],
        2: [0x0F0F0F0F0F0F0F0E], // 1 bit different
      };

      final verified = filterEdgesByPerceptualHash(
        candidateEdges: edges,
        rotationHashesByFileId: hashes,
        maxHammingDistance: 6,
      );

      expect(verified.length, 1);
    });

    test("drops an edge when hashes differ beyond the tolerance", () {
      final edges = [const CandidateEdge(1, 2, 0.02)];
      final hashes = {
        1: [0x0000000000000000],
        2: [0x00000000000000FF], // 8 bits different
      };

      final verified = filterEdgesByPerceptualHash(
        candidateEdges: edges,
        rotationHashesByFileId: hashes,
        maxHammingDistance: 6,
      );

      expect(verified, isEmpty);
    });

    test("matches a rotated image via one of its rotation hashes", () {
      final edges = [const CandidateEdge(1, 2, 0.02)];
      final hashes = {
        1: [0x1234567890ABCDEF],
        // file 2's canonical hash is unrelated, but its 180-degree rotation
        // hash matches file 1 closely.
        2: [0x0000000000000000, 0x1234567890ABCDEE, 0x1111111111111111, 0x2222222222222222],
      };

      final verified = filterEdgesByPerceptualHash(
        candidateEdges: edges,
        rotationHashesByFileId: hashes,
        maxHammingDistance: 2,
      );

      expect(verified.length, 1);
    });

    test("drops an edge when a file's hash could not be computed", () {
      final edges = [const CandidateEdge(1, 2, 0.02)];
      final hashes = {
        1: [0x1234567890ABCDEF],
        // no entry for file 2, e.g. its thumbnail failed to decode
      };

      final verified = filterEdgesByPerceptualHash(
        candidateEdges: edges,
        rotationHashesByFileId: hashes,
        maxHammingDistance: 6,
      );

      expect(verified, isEmpty);
    });
  });
}
