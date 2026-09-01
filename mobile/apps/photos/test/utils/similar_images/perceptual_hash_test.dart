import "dart:math";
import "dart:typed_data";

import "package:image/image.dart" as img;
import "package:photos/utils/similar_images/perceptual_hash.dart";
import "package:test/test.dart";

/// Builds a deterministic test image whose gradient direction, checkerboard
/// block size, and palette all vary with [seed], so that images built from
/// different seeds are actually visually distinct (not just noisy variants
/// of the same underlying pattern) while images from the same seed are
/// pixel-identical.
Uint8List _buildTestImagePng(int seed) {
  final random = Random(seed);
  final blockSize = 8 + random.nextInt(24);
  final gradientAngleDegrees = random.nextInt(360);
  final paletteOffset = random.nextInt(255);

  final image = img.Image(width: 160, height: 120);
  final angleRadians = gradientAngleDegrees * 3.141592653589793 / 180;
  final dx = cos(angleRadians);
  final dy = sin(angleRadians);

  for (int y = 0; y < image.height; y++) {
    for (int x = 0; x < image.width; x++) {
      final projected = (x * dx + y * dy).round();
      final checker = ((x ~/ blockSize) + (y ~/ blockSize)) % 2;
      final r = (projected + paletteOffset) % 256;
      final g = (255 - ((projected + paletteOffset) % 256)).abs();
      final b = checker == 0 ? 40 : 220;
      image.setPixelRgb(x, y, r.abs(), g.abs(), b);
    }
  }
  return img.encodePng(image);
}

void main() {
  group("dHashFromBytes / hammingDistance", () {
    test("is stable for the same image", () {
      final bytes = _buildTestImagePng(1);
      final hashA = dHashFromBytes(bytes);
      final hashB = dHashFromBytes(bytes);
      expect(hashA, isNotNull);
      expect(hashA, equals(hashB));
      expect(hammingDistance(hashA!, hashB!), 0);
    });

    test("is close for a lightly re-encoded/resized copy", () {
      final original = _buildTestImagePng(2);
      final decoded = img.decodeImage(original)!;
      final resized = img.copyResize(decoded, width: 96, height: 72);
      final reencoded = img.encodeJpg(resized, quality: 80);

      final hashOriginal = dHashFromBytes(original)!;
      final hashResized = dHashFromBytes(reencoded)!;

      expect(hammingDistance(hashOriginal, hashResized), lessThanOrEqualTo(6));
    });

    test("is far for two unrelated images", () {
      final imageA = _buildTestImagePng(3);
      final imageB = _buildTestImagePng(999);

      final hashA = dHashFromBytes(imageA)!;
      final hashB = dHashFromBytes(imageB)!;

      expect(hammingDistance(hashA, hashB), greaterThan(10));
    });

    test("returns null for undecodable bytes", () {
      final hash = dHashFromBytes(Uint8List.fromList([1, 2, 3, 4]));
      expect(hash, isNull);
    });
  });

  group("dHashForAllRotations / minHammingDistanceAcrossRotations", () {
    test("matches a 90-degree-rotated copy of the same photo", () {
      final original = _buildTestImagePng(4);
      final decoded = img.decodeImage(original)!;
      final rotated = img.copyRotate(decoded, angle: 90);
      final rotatedBytes = img.encodePng(rotated);

      final canonicalHash = dHashFromBytes(original)!;
      final rotatedHashes = dHashForAllRotations(rotatedBytes);

      expect(rotatedHashes, hasLength(4));
      expect(
        minHammingDistanceAcrossRotations(canonicalHash, rotatedHashes),
        lessThanOrEqualTo(6),
      );
    });

    test(
      "does not spuriously match an unrelated image across rotations",
      () {
        final imageA = _buildTestImagePng(5);
        final imageB = _buildTestImagePng(1234);

        final hashA = dHashFromBytes(imageA)!;
        final rotationsB = dHashForAllRotations(imageB);

        expect(
          minHammingDistanceAcrossRotations(hashA, rotationsB),
          greaterThan(10),
        );
      },
    );
  });
}
