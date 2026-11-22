'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fail } = require('./security');
async function identify(filename, name) {
  const { fileTypeFromFile } = await import('file-type');
  let result;
  try { result = await fileTypeFromFile(filename); } catch (err) { if (err.name !== 'EndOfStreamError') throw err; }
  if (result) return result;
  const fd = fs.openSync(filename, 'r');
  const bytes = Buffer.alloc(4096); let n;
  try { n = fs.readSync(fd, bytes); } finally { fs.closeSync(fd); }
  if (['.txt', '.csv', '.json'].includes(path.extname(name).toLowerCase()) && !bytes.subarray(0, n).includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n), { stream: true }); return { ext: 'txt', mime: 'text/plain' }; } catch { /* binary */ }
  }
  return { ext: 'bin', mime: 'application/octet-stream' };
}
function command(config, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'ignore' });
    let timedOut = false;
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; stop(); }, config.conversionTimeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', finish);
    child.once('close', code => finish(code === 0 && !signal.aborted && !timedOut ? null : new Error('media conversion failed')));
    function finish(err) {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      if (err) reject(err); else resolve();
    }
  });
}
let tail = Promise.resolve();
async function convert(config, input, output, detected, signal) {
  const video = ['video/quicktime', 'video/x-matroska'].includes(detected.mime);
  const audio = ['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/x-flac', 'audio/aac', 'audio/ogg', 'audio/x-ms-wma', 'audio/mp4', 'audio/x-m4a'].includes(detected.mime);
  if (!config.convertMedia || (!video && !audio)) return null;
  const run = async () => {
    if (signal.aborted) fail(408, 'upload interrupted');
    if (video) {
      try { await command(config, ['-y', '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output], signal); }
      catch (err) {
        if (signal.aborted) throw err;
        await command(config, ['-y', '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', output], signal);
      }
      return { ext: 'mp4', mime: 'video/mp4' };
    }
    await command(config, ['-y', '-protocol_whitelist', 'file,pipe', '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', output], signal);
    return { ext: 'mp3', mime: 'audio/mpeg' };
  };
  const result = tail.then(run);
  tail = result.catch(() => {});
  return result;
}
module.exports = { identify, convert };
