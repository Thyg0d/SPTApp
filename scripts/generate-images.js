'use strict';
/**
 * Generates the three required Homey app store PNG images.
 *
 * Usage:  node scripts/generate-images.js
 *
 * xlarge.png (1000×700) and large.png (500×350) are produced by
 * centre-cropping assets/images/hero-soruce.png to the required
 * aspect ratio (10:7).
 *
 * small.png (75×75) is the app icon SVG on a matching dark background.
 */

const sharp = require('sharp');
const path  = require('path');

const root   = path.resolve(__dirname, '..');
const outDir = path.join(root, 'assets/images');
const source = path.join(outDir, 'hero-soruce.png');

// ── Main ──────────────────────────────────────────────────────────────
async function run() {
  // All three app store image sizes — resize + centre-crop source
  await sharp(source)
    .resize(1000, 700, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(outDir, 'xlarge.png'));
  console.log('✓  xlarge.png  (1000×700)');

  await sharp(source)
    .resize(500, 350, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(outDir, 'large.png'));
  console.log('✓  large.png   ( 500×350)');

  await sharp(source)
    .resize(250, 175, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(outDir, 'small.png'));
  console.log('✓  small.png   ( 250×175)');
}

run().catch(err => { console.error(err); process.exit(1); });
