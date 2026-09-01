import "dart:typed_data" show Uint8List;

import "package:image/image.dart" as img;

/// A 64-bit difference hash ("dHash") of a downsampled grayscale image.
///
/// dHash is sensitive to the actual visual structure of an image (unlike a
/// CLIP embedding, which is sensitive to semantic content), which is what
/// makes it useful for verifying that two images CLIP thinks look similar
/// are actually the same underlying photo rather than merely similar-looking.
/// It is not rotation-invariant by itself; use [dHashForAllRotations] and
/// [minHammingDistanceAcrossRotations] to compare images that may differ by
/// a 90/180/270 degree rotation.
const int dHashGridWidth = 9;
const int dHashGridHeight = 8;

/// Decodes [bytes] and returns its dHash, or `null` if the image could not
/// be decoded.
int? dHashFromBytes(Uint8List bytes) {
  try {
    final decoded = img.decodeImage(bytes);
    if (decoded == null) return null;
    return dHashFromImage(decoded);
  } catch (_) {
    // Malformed/truncated image bytes can make some format sniffers throw
    // rather than return null; treat that the same as "could not decode".
    return null;
  }
}

/// Computes the dHash of an already-decoded [image].
int dHashFromImage(img.Image image) {
  final resized = img.copyResize(
    image,
    width: dHashGridWidth,
    height: dHashGridHeight,
    interpolation: img.Interpolation.average,
  );
  final grayscale = img.grayscale(resized);

  int hash = 0;
  for (int y = 0; y < dHashGridHeight; y++) {
    for (int x = 0; x < dHashGridWidth - 1; x++) {
      final left = grayscale.getPixel(x, y).luminance;
      final right = grayscale.getPixel(x + 1, y).luminance;
      hash = (hash << 1) | (left > right ? 1 : 0);
    }
  }
  return hash;
}

/// Decodes [bytes] once and returns its dHash at each of the four
/// axis-aligned rotations (0, 90, 180, 270 degrees), so that a rotated copy
/// of the same photo can still be matched. Returns an empty list if the
/// image could not be decoded.
List<int> dHashForAllRotations(Uint8List bytes) {
  try {
    final decoded = img.decodeImage(bytes);
    if (decoded == null) return const [];

    final hashes = <int>[];
    img.Image current = decoded;
    for (int turn = 0; turn < 4; turn++) {
      hashes.add(dHashFromImage(current));
      if (turn < 3) {
        current = img.copyRotate(current, angle: 90);
      }
    }
    return hashes;
  } catch (_) {
    return const [];
  }
}

/// Number of differing bits between two 64-bit hashes.
int hammingDistance(int a, int b) {
  int x = a ^ b;
  int count = 0;
  while (x != 0) {
    count += x & 1;
    x >>>= 1;
  }
  return count;
}

/// The smallest Hamming distance between [hash] and any hash in
/// [otherRotationHashes], i.e. the best match across all rotations of the
/// other image.
int minHammingDistanceAcrossRotations(int hash, List<int> otherRotationHashes) {
  int best = 64;
  for (final other in otherRotationHashes) {
    final distance = hammingDistance(hash, other);
    if (distance < best) {
      best = distance;
    }
  }
  return best;
}
