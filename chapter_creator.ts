import { StringReader } from "https://deno.land/std@0.178.0/io/string_reader.ts";

const file = "Mkv\ Sample.mkv"


class KeyFrame {
  best_effort_timestamp: number;
  pkt_pos: number;

  static frameRegEX = /.*best_effort_timestamp=(\d+).*pkt_pos=(\d+).*/su;

  constructor(frameData: string) {
    const matches = frameData.match(KeyFrame.frameRegEX)
    if (!matches || matches.length < 3) {
      throw new Error("couldn't parse framedata")
    }
    this.best_effort_timestamp = parseInt(matches[1]);
    this.pkt_pos = parseInt(matches[2]);
  }
}

class KeyFrameCollection {
  private keyFrames: KeyFrame[]; 
  
  constructor(keyFrames: KeyFrame[]) {
    this.keyFrames = keyFrames;
  }

  /* 
    Generate a chapter document/string from key frame start/end times. 

    Example: 

    [CHAPTER]
    TIMEBASE=1/1000
    START=0
    END=180000
    title=Chapter 1
    [CHAPTER]
    TIMEBASE=1/1000
    START=180000
    END=360000
    title=Chapter 2
    [CHAPTER]
    TIMEBASE=1/1000
    START=360000 
    END=540000
    title=Chapter 3
    [CHAPTER]
  */
  public generateChapterMetadata(): string {
    let chapterString = ";FFMETADATA1\n";
    let lastFrame: KeyFrame | undefined;
    for (const frame of this.keyFrames) {
      if (!lastFrame) {
        chapterString += `[CHAPTER]\n`
        chapterString += `TIMEBASE=1/1000\n`
        chapterString += `START=0\n`
        chapterString += `END=${frame.best_effort_timestamp}\n`
        chapterString += `title=Chapter 1\n`
      } else {
        chapterString += `[CHAPTER]\n`
        chapterString += `TIMEBASE=1/1000\n`
        chapterString += `START=${lastFrame.best_effort_timestamp}\n`
        chapterString += `END=${frame.best_effort_timestamp}\n`
        chapterString += `title=Chapter ${this.keyFrames.indexOf(frame) + 1}\n`
      }
      lastFrame = frame;
    }
    return chapterString;
  }
}

type KFPromiseResolve = (keyFrames: KeyFrameCollection) => void;
type KFPromiseReject = (reason: Error) => void;

class KeyFrameCollector {
  private stringBuffer = ""
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private frameRegEx = /\[FRAME\](.*key_frame=(\d).*)\[\/FRAME\]/su;
  private keyFrames: KeyFrame[] = [];
  private completionPromise: Promise<KeyFrameCollection>;
  private resolve!: (KeyFrameCollection: KeyFrameCollection) => void;
  private reject!: (reason: Error) => void;  

  constructor() {
    const self = this;
    this.completionPromise = new Promise((resolve: KFPromiseResolve, reject: KFPromiseReject) => {
      self.resolve = resolve;
      self.reject = reject;
    }) 
  }
  start(controller: WritableStreamDefaultController) {
    const self = this;
  } 

  write(chunk : Uint8Array, controller: WritableStreamDefaultController) {
    this.stringBuffer += this.textDecoder.decode(chunk)

    let matches: RegExpMatchArray | null;
    while ((matches = this.stringBuffer.match(this.frameRegEx))?.length === 3) {
      // pass on the key frames
      if (matches![2] === "1") {
        this.keyFrames.push(new KeyFrame(matches![1]))
        //console.error(this.keyFrames[this.keyFrames.length - 1])
      }
      // remove the frame regardless of contents
      this.stringBuffer = this.stringBuffer.replace(this.frameRegEx, "")
    }
  }

  // returns a promise that is resolved when the frames have been processes
  async processingDone(): Promise<KeyFrameCollection> {
    return this.completionPromise;
  }

  close() {
    this.resolve(new KeyFrameCollection(this.filterFrames()));
  }

  abort(reason: Error) { 
    this.reject(reason)
  }

  // return frames from keyFrames every 180000 milliseconds (best_effort_timestamp)
  filterFrames(): KeyFrame[] {
    const filteredFrames: KeyFrame[] = [];
    let lastFrame: KeyFrame = this.keyFrames[0];
    for (const frame of this.keyFrames) {
      if (frame.best_effort_timestamp - lastFrame.best_effort_timestamp > 180000) {
        filteredFrames.push(frame)
        lastFrame = frame;
      }
    }
    return filteredFrames;
  }
}

async function chapterize(inFile: string, outFile: string) {
  const keyFrameCollector = new KeyFrameCollector();
  const kfStream = new WritableStream(keyFrameCollector)
  
  console.log(`Calculating chapters for ${inFile}`)
  const keyframeProcess = Deno.run({cmd: ["ffprobe", "-select_streams",  "v", "-show_frames", inFile], stdout: "piped", stderr: "null"})
  keyframeProcess.stdout?.readable.pipeTo(kfStream)
  const keyFrameCollection = await keyFrameCollector.processingDone();

  const chapterizeProcess = Deno.run({ 
    cmd: ["ffmpeg", "-i", inFile, "-i", "-", "-map_chapters", "1", "-codec", "copy", outFile], 
    stdin: "piped",
    stdout: "null", 
    stderr: "inherit"})
  

  chapterizeProcess.stdin.write(new TextEncoder().encode(keyFrameCollection.generateChapterMetadata()))
  chapterizeProcess.stdin.close();
  const promiseStatus = await chapterizeProcess.status();
  if (!promiseStatus.success) {
    throw new Error("could not write chapters");
  }
}

await chapterize("./small.mkv", "small.out.mkv")

