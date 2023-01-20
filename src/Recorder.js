import canvasScreenshot from "canvas-screenshot";

import WebCodecsEncoder from "./encoders/WebCodecsEncoder.js";
import H264MP4Encoder from "./encoders/H264MP4Encoder.js";
import GIFEncoder from "./encoders/GIFEncoder.js";
import FrameEncoder from "./encoders/FrameEncoder.js";

import {
  formatDate,
  formatSeconds,
  isWebCodecsSupported,
  nextMultiple,
} from "./utils.js";

/**
 * Enum for recorder status
 * @readonly
 * @enum {number}
 *
 * @example
 * ```js
 * // Check recorder status before continuing
 * if (canvasRecorder.status !== RecorderStatus.Stopped) {
 *   rAFId = requestAnimationFrame(() => tick());
 * }
 * ```
 */
const RecorderStatus = Object.freeze({
  Ready: 0,
  Initializing: 1,
  Recording: 2,
  Stopping: 3,
  Stopped: 4,
});

/**
 * A callback to notify on the status change. To compare with RecorderStatus enum values.
 * @name onStatusChangeCb
 * @function
 * @param {number} RecorderStatus the status
 */

/**
 * @typedef {Object} RecorderOptions Options for recording. All optional.
 * @property {string} [name=""] A name for the recorder, used as prefix for the default file name.
 * @property {string} [filename] Overwrite the file name completely.
 * @property {number} [duration=10] The recording duration in seconds. If set to Infinity, `await canvasRecorder.stop()` needs to be called manually.
 * @property {number} [frameRate=30] The frame rate in frame per seconds. Use `await canvasRecorder.step();` to go to the next frame.
 * @property {boolean} [download=true] Automatically download the recording when duration is reached or when `await canvasRecorder.stop()` is manually called.
 * @property {boolean} [extension="mp4"] Default file extension: infers which Encoder is selected.
 * @property {Object} [encoder] A specific encoder. Default encoder based on options.extension: GIF > WebCodecs > H264MP4.
 * @property {Object} [encoderOptions={}] See `src/encoders` or individual packages for a list of options.
 * @property {onStatusChangeCb} [onStatusChange]
 */

let link;

/**
 * Base Recorder class.
 * @property {boolean} [enabled=true] Enable/disable pointer interaction and drawing.
 */
class Recorder {
  static defaultOptions = {
    name: "",
    duration: 3, // 0 to Infinity
    frameRate: 30,
    download: true,
    extension: "mp4",
    onStatusChange: () => {},
  };

  static mimeTypes = {
    mkv: "video/x-matroska;codecs=avc1",
    webm: "video/webm",
    mp4: "video/mp4",
    gif: "image/gif",
  };

  static downloadBlob(filename, blobPart, mimeType) {
    link ||= document.createElement("a");
    link.download = filename;

    const blob = new Blob(blobPart, { type: mimeType });
    const url = URL.createObjectURL(blob);
    link.href = url;

    const event = new MouseEvent("click");
    link.dispatchEvent(event);

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1);
  }

  set width(value) {
    this.encoder.width = value;
  }
  set height(value) {
    this.encoder.height = value;
  }

  // TODO: allow overwrite
  get width() {
    return this.context.drawingBufferWidth || this.context.canvas.width;
  }
  get height() {
    return this.context.drawingBufferHeight || this.context.canvas.height;
  }

  get stats() {
    const renderTime = (Date.now() - this.startTime.getTime()) / 1000;
    const secondsPerFrame = renderTime / this.frame;

    return {
      renderTime,
      secondsPerFrame,
      detail: `Time: ${this.time.toFixed(2)} / ${this.duration.toFixed(2)}
Frame: ${this.frame} / ${this.frameTotal}
Elapsed Time: ${formatSeconds(renderTime)}
Remaining Time: ${formatSeconds(secondsPerFrame * this.frameTotal - renderTime)}
Speedup: x${(this.time / renderTime).toFixed(1)}`,
    };
  }

  #updateStatus(status) {
    this.status = status;
    this.onStatusChange(this.status);
  }

  getParamString() {
    return `${this.width}x${this.height}@${this.frameRate}fps`;
  }

  getDefaultFileName(extension) {
    return `${[this.name, formatDate(this.startTime), this.getParamString()]
      .filter(Boolean)
      .join("-")}.${extension}`;
  }

  getSupportedExtension() {
    const CurrentEncoder = this.encoder.constructor;
    const isExtensionSupported = CurrentEncoder.supportedExtensions.includes(
      this.extension
    );
    const extension = isExtensionSupported
      ? this.extension
      : CurrentEncoder.supportedExtensions[0];

    if (!isExtensionSupported) {
      console.warn(
        `canvas-record: unsupported extension for encoder "${CurrentEncoder.name}". Defaulting to "${extension}".`
      );
    }
    return extension;
  }

  /**
   * @param {RenderingContext} context
   * @param {RecorderOptions} options
   */
  constructor(context, options = {}) {
    this.context = context;

    const opts = { ...Recorder.defaultOptions, ...options };
    Object.assign(this, opts);

    if (!this.encoder) {
      if (this.extension === "gif") {
        this.encoder = new GIFEncoder(opts);
      } else if (["png", "jpg"].includes(this.extension)) {
        this.encoder = new FrameEncoder(opts);
      } else {
        this.encoder = isWebCodecsSupported
          ? new WebCodecsEncoder(opts)
          : new H264MP4Encoder(opts);
      }
    }

    this.#updateStatus(RecorderStatus.Ready);
  }

  /**
   * Sets up the recorder internals and the encoder depending on supported features.
   * @private
   */
  async init() {
    this.#updateStatus(RecorderStatus.Initializing);

    this.deltaTime = 1 / this.frameRate;
    this.time = 0;
    this.frame = 0;
    this.frameTotal = this.duration * this.frameRate;

    const extension = this.getSupportedExtension();

    await this.encoder.init({
      encoderOptions: this.encoderOptions,
      canvas: this.context.canvas,
      width: this.width,
      height: this.height,
      frameRate: this.frameRate,
      extension,
      mimeType: Recorder.mimeTypes[extension],
      paramString: this.getParamString(),
      debug: this.debug,
    });

    this.#updateStatus(RecorderStatus.Initialized);
  }

  /**
   * Start the recording by initializing and calling the initial step.
   */
  async start() {
    await this.init();

    // Ensure initializing worked
    if (this.status !== RecorderStatus.Initialized) {
      console.debug("canvas-record: recorder not initialized.");
      return;
    }

    this.startTime = new Date();
    this.filename ||= this.getDefaultFileName(this.encoder.extension);

    this.#updateStatus(RecorderStatus.Recording);

    await this.step();
  }

  /**
   * Convert the context into something encodable (bitmap, blob, buffer...)
   * @private
   */
  async getFrame(frameMethod) {
    switch (frameMethod) {
      case "bitmap": {
        return await createImageBitmap(this.context.canvas);
      }
      case "videoFrame": {
        return new VideoFrame(this.context.canvas, {
          timestamp: this.time * 1_000_000, // in µs
        });
      }
      case "requestFrame": {
        return undefined;
      }
      case "imageData": {
        if (this.context.drawingBufferWidth) {
          const width = this.context.drawingBufferWidth;
          const height = this.context.drawingBufferHeight;
          const length = width * height * 4;
          const pixels = new Uint8Array(length);
          const pixelsFlipped = new Uint8Array(length);

          this.context.readPixels(
            0,
            0,
            width,
            height,
            this.context.RGBA,
            this.context.UNSIGNED_BYTE,
            pixels
          );

          // Flip vertically
          const row = width * 4;
          const end = (height - 1) * row;
          for (let i = 0; i < length; i += row) {
            pixelsFlipped.set(pixels.subarray(i, i + row), end - i);
          }

          return pixelsFlipped;
        }

        return this.context.getImageData(
          0,
          0,
          nextMultiple(this.width, 2),
          nextMultiple(this.height, 2)
        ).data;
      }
      default: {
        return await canvasScreenshot(this.context.canvas, {
          useBlob: true,
          download: false,
          filename: `output.${this.encoder.extension}`,
        });
      }
    }
  }

  /**
   * Encode a frame and increment the time and the playhead.
   * Calls `await canvasRecorder.stop()` when duration is reached.
   */
  async step() {
    if (
      this.status === RecorderStatus.Recording &&
      this.frame < this.frameTotal
    ) {
      await this.encoder.encode(
        await this.getFrame(this.encoder.frameMethod),
        this.frame
      );
      this.time += this.deltaTime;
      this.frame++;
    } else {
      await this.stop();
    }
  }

  /**
   * Stop the recording and return the recorded buffer.
   * If options.download is set, automatically start downloading the resulting file.
   * Is called when duration is reached or manually.
   */
  async stop() {
    if (this.status !== RecorderStatus.Recording) return;

    this.#updateStatus(RecorderStatus.Stopping);

    const buffer = await this.encoder.stop();

    if (this.download && buffer) {
      Recorder.downloadBlob(
        this.filename,
        Array.isArray(buffer) ? buffer : [buffer],
        this.encoder.mimeType
      );
    }
    this.#updateStatus(RecorderStatus.Stopped);

    return buffer;
  }

  /**
   * Clean up
   */
  async dispose() {
    await this.encoder.dispose();
  }
}

export { Recorder, RecorderStatus };
