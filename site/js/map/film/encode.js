// Film encoders. Owner: lane b10.
// First choice: WebCodecs H.264 into an MP4 file (mp4-muxer), exact timestamps (frame i at i / fps), plays on phones.
// Fallback: MediaRecorder on the compositor canvas (MP4 if the browser records it, else WebM), paced in real time.
//
// createEncoder({canvas, width, height, fps, bitrate}) -> Promise<{kind 'mp4'|'webm', mime, codec, via,
//   add(i) -> Promise (encode the canvas as frame i), finish() -> Promise<Blob>, abort()}>

const H264 = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f'];

export async function h264Config(width, height, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const codec of H264) {
    for (const hw of ['no-preference', 'prefer-software']) {
      const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: hw, latencyMode: 'quality' };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return r.config || cfg;
      } catch { /* try the next */ }
    }
  }
  return null;
}

export function recorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = ['video/mp4;codecs=avc3.42E01E', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || null;
}

async function webcodecsMp4({ canvas, width, height, fps, bitrate }, cfg) {
  const { Muxer, ArrayBufferTarget } = await import('../../../vendor/mp4-muxer/mp4-muxer.mjs');
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let failure = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { failure = e; } },
    error: (e) => { failure = e; },
  });
  enc.configure(cfg);
  const us = 1e6 / fps;
  return {
    kind: 'mp4', mime: 'video/mp4', codec: cfg.codec, via: 'webcodecs',
    async add(i) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * us), duration: Math.round(us) });
      try { enc.encode(frame, { keyFrame: i % (fps * 2) === 0 }); } finally { frame.close(); }
      // Keep the queue short so memory stays flat on slow machines.
      while (enc.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 4));
    },
    async finish() {
      await enc.flush();
      if (failure) throw failure;
      muxer.finalize();
      try { enc.close(); } catch { /* closed */ }
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
    abort() { try { enc.close(); } catch { /* closed */ } },
  };
}

async function mediaRecorder({ canvas, fps, bitrate }, mime) {
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const parts = [];
  rec.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
  rec.start(250);
  let last = 0;
  return {
    kind: mime.startsWith('video/mp4') ? 'mp4' : 'webm', mime: mime.split(';')[0], codec: mime, via: 'mediarecorder',
    async add() {
      // MediaRecorder stamps frames by the wall clock: hold each one at least 1/fps so the film keeps its speed.
      const wait = last + 1000 / fps - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (track.requestFrame) track.requestFrame();
      last = performance.now();
    },
    finish() {
      return new Promise((resolve) => {
        rec.onstop = () => { track.stop(); resolve(new Blob(parts, { type: mime.split(';')[0] })); };
        setTimeout(() => rec.state !== 'inactive' && rec.stop(), 1000 / fps + 30);
      });
    },
    abort() { try { rec.stop(); track.stop(); } catch { /* stopped */ } },
  };
}

export async function createEncoder(opts) {
  const o = { fps: 30, ...opts };
  o.width -= o.width % 2;
  o.height -= o.height % 2;
  o.bitrate = o.bitrate || Math.round(Math.min(12e6, Math.max(3e6, o.width * o.height * o.fps * 0.2)));
  if (!o.forceFallback) {
    const cfg = await h264Config(o.width, o.height, o.fps, o.bitrate);
    if (cfg) {
      try { return await webcodecsMp4(o, cfg); } catch (e) { console.warn('[film] H.264 encoder unavailable, using the recorder', e); }
    }
  }
  const mime = recorderMime();
  if (!mime || !o.canvas.captureStream) return null;
  return mediaRecorder(o, mime);
}
