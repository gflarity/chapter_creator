import { StringReader } from "https://deno.land/std@0.178.0/io/string_reader.ts";
import { walk } from "https://deno.land/std@0.177.0/fs/walk.ts";
import * as path from "https://deno.land/std@0.170.0/path/mod.ts";
import * as fs from "https://deno.land/std@0.178.0/fs/mod.ts"

import { EasySink } from "./easy_streams.ts";
import { Deferred } from "https://deno.land/x/deferred@v1.0.1/mod.ts";

// Configuration can bet set as environment variables or using .env file:
import "https://deno.land/std@0.178.0/dotenv/load.ts"

const chapterLength = parseInt(Deno.env.get("CHAPTER_LENGTH") || "180");

class KeyFrame {
  pts_time: number;
  pkt_pos: number;

  public static frameRegEx = /.*pts_time=(\d+).*pkt_pos=(\d+).*/su;

  constructor(frameData: string) {
    const matches = frameData.match(KeyFrame.frameRegEx);
    if (!matches || matches.length < 3) {
      throw new Error("couldn't parse framedata");
    }
    this.pts_time = parseInt(matches[1]);
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
        chapterString += `[CHAPTER]\n`;
        chapterString += `TIMEBASE=1/1\n`;
        chapterString += `START=0\n`;
        chapterString += `END=${frame.pts_time}\n`;
        chapterString += `title=Chapter 1\n`;
      } else {
        chapterString += `[CHAPTER]\n`;
        chapterString += `TIMEBASE=1/1\n`;
        chapterString += `START=${lastFrame.pts_time}\n`;
        chapterString += `END=${frame.pts_time}\n`;
        chapterString += `title=Chapter ${this.keyFrames.indexOf(frame) + 1}\n`;
      }
      lastFrame = frame;
    }
    return chapterString;
  }
}


async function chapterize(inFile: string, outFile: string) {

  const keyFrameCollector = new EasySink();
  let stringBuffer = "";
  const textDecoder = new TextDecoder();
  const frameRegEx = /\[FRAME\](.*key_frame=(\d).*)\[\/FRAME\]/su;
  const textEncoder = new TextEncoder();
  const keyFrames: KeyFrame[] = [];
  const deferredKeyFrameCollection = new Deferred<KeyFrameCollection>();  
  keyFrameCollector.onWrite((chunk, controller) => {
    stringBuffer += textDecoder.decode(chunk);

    let matches: RegExpMatchArray | null;
    while ((matches = stringBuffer.match(frameRegEx))?.length === 3) {
      // pass on the key frames
      if (matches![2] === "1") {
        keyFrames.push(new KeyFrame(matches![1]));
        //console.error(this.keyFrames[this.keyFrames.length - 1])
        Deno.stdout.write(textEncoder.encode("."));
      }
      // remove the frame regardless of contents
      stringBuffer = stringBuffer.replace(frameRegEx, "");
    }
  })
  keyFrameCollector.onClose(() => {

    const filteredFrames: KeyFrame[] = [];
    let lastFrame: KeyFrame = keyFrames[0];
    for (const frame of keyFrames) {
      if (frame.pts_time - lastFrame.pts_time > chapterLength) {
        filteredFrames.push(frame);
        lastFrame = frame;
      }
    }
    deferredKeyFrameCollection.resolve(new KeyFrameCollection(filteredFrames)     
    )
  });
  keyFrameCollector.onAbort((reason) => {
    deferredKeyFrameCollection.reject(reason)
  })
  
  console.log(`Calculating chapters for ${inFile}`);
  const keyframeProcess = Deno.run({
    cmd: [
      "ffprobe",
      "-select_streams",
      "v",
      "-show_frames",
      "-skip_frame",
      "nokey",
      inFile,
    ],
    stdout: "piped",
    stderr: "null",
  });

  keyframeProcess.stdout?.readable.pipeTo(keyFrameCollector.asWritableStream());
  const keyFrameCollection = await deferredKeyFrameCollection;

  const chapterizeProcess = Deno.run({
    cmd: [
      "ffmpeg",
      "-i",
      inFile,
      "-i",
      "-",
      "-map_chapters",
      "1",
      "-codec",
      "copy",
      outFile,
    ],
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  });

  let stderr = "";
  chapterizeProcess.stderr.readable.pipeTo(new WritableStream({
    write(chunk: Uint8Array) {
      stderr += new TextDecoder().decode(chunk);
    }
  }));

  chapterizeProcess.stdin.write(
    new TextEncoder().encode(keyFrameCollection.generateChapterMetadata())
  );  
  chapterizeProcess.stdin.close();

  // wait for processing to complete, throw error if there was an issue
  const promiseStatus = await chapterizeProcess.status();
  if (!promiseStatus.success) {
    const output = await chapterizeProcess.stderrOutput();
    throw new Error("could not write chapters, here's the stderr: \n" + stderr);
  }

  // update the file atime/mtime to match the old file
  const fileInfo = await Deno.stat(inFile);
  await Deno.utime(outFile, fileInfo.atime as Date, fileInfo.mtime as Date);  
}

if (!Deno.args[0] || !Deno.args[1]) {
  console.log(
    "usage: deno run --allow-read --allow-run --allow-write chapterize.ts <source dir> <destination dir>",
  );
  Deno.exit(1);
}

// test that destDir exists, if it doesn't make it so
try {
  await Deno.stat(Deno.args[1]);
} catch (e) {
  // make the directory since it doesn't exist
  await Deno.mkdir(Deno.args[1]);
}

const sourceDir = Deno.realPathSync(Deno.args[0]);
const destDir: string = Deno.realPathSync(Deno.args[1]);

console.log(`source: ${sourceDir} destination: ${destDir}`);
Deno.mkdir(destDir, { recursive: true });

// recursively walk through a directory looking for .mkv and .mp4 files
for await (
  const entry of walk(sourceDir, { match: [new RegExp("(mp4|mkv)$", "i")] })
) {
  const sourcePath = entry.path;
  const destPath = sourcePath.replace(sourceDir, destDir);

  // if the destination file already exists, just skip this source file
  // notee that fs.exists is deprecated, but it just uses Deno.stat which is the alternative I'd use anyways...
  if (await fs.exists(destPath)) {
    console.log(`${destPath} exists, skipping...`)
    continue;
  }

  try {
    // there might be sub directories in the destPath, so we need to make sure we create them...
    const baseDir = path.dirname(destPath);
    await Deno.mkdir(baseDir, { recursive: true });
    console.log(`${sourcePath}->${destPath}`);
    await chapterize(sourcePath, destPath);
  } catch (e) {
    console.error(e);
  }
}

