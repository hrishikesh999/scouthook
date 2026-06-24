'use strict';

const sharp = require('sharp');
const storage = require('./storage');

const W = 1080;
const H = 1080;
const FACECAM_SIZE = 200;
const FACECAM_MARGIN = 32;
const FACECAM_BORDER = 6;

async function renderProofScreenshot(post, content, ctx = {}) {
  const { userId, tenantId } = ctx;
  const { screenshotBuffer, faceBuffer } = content;

  if (!screenshotBuffer) throw new Error('Screenshot image is required');
  if (!faceBuffer) throw new Error('Face photo is required');

  const bg = await sharp(screenshotBuffer)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  const outerSize = FACECAM_SIZE + FACECAM_BORDER * 2;
  const faceCropped = await sharp(faceBuffer)
    .resize(FACECAM_SIZE, FACECAM_SIZE, { fit: 'cover' })
    .png()
    .toBuffer();

  const circularMask = Buffer.from(
    `<svg width="${FACECAM_SIZE}" height="${FACECAM_SIZE}">
      <circle cx="${FACECAM_SIZE / 2}" cy="${FACECAM_SIZE / 2}" r="${FACECAM_SIZE / 2}" fill="white"/>
    </svg>`
  );

  const circularFace = await sharp(faceCropped)
    .composite([{ input: circularMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const borderCircle = Buffer.from(
    `<svg width="${outerSize}" height="${outerSize}">
      <circle cx="${outerSize / 2}" cy="${outerSize / 2}" r="${outerSize / 2}" fill="white"/>
    </svg>`
  );

  const faceCamX = W - outerSize - FACECAM_MARGIN;
  const faceCamY = H - outerSize - FACECAM_MARGIN;

  const pngBuffer = await sharp(bg)
    .composite([
      { input: borderCircle, left: faceCamX, top: faceCamY },
      { input: circularFace, left: faceCamX + FACECAM_BORDER, top: faceCamY + FACECAM_BORDER },
    ])
    .png()
    .toBuffer();

  const filename = `proof_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { png_url: `/files/${filename}` };
}

module.exports = { renderProofScreenshot };
