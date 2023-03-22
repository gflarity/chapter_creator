import { StringReader } from "https://deno.land/std@0.178.0/io/string_reader.ts";
import { walk } from "https://deno.land/std@0.177.0/fs/walk.ts";
import * as path from "https://deno.land/std@0.170.0/path/mod.ts";
import * as fs from "https://deno.land/std@0.178.0/fs/mod.ts"

import { Deferred } from "https://deno.land/x/deferred@v1.0.1/mod.ts";

// Configuration can bet set as environment variables or using .env file:
import "https://deno.land/std@0.178.0/dotenv/load.ts"

const chapterLength = parseInt(Deno.env.get("CHAPTER_LENGTH") || "180");

// Simple KeyFrame object
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

async function chapterize(inFile: string, outFile: string) {

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

  // This transform takes string stream from the command above and parses out keyframes
  const frameRegEx = /\[FRAME\](.*key_frame=(\d).*)\[\/FRAME\]/su;
  let stringBuffer = "";
  const keyFrameCollector = new TransformStream({
    transform(chunk: string, controller) {
      stringBuffer += chunk;
      let matches: RegExpMatchArray | null;
      while ((matches = stringBuffer.match(frameRegEx))?.length === 3) {        
        // pass on the key frames
        if (matches![2] === "1") {
          controller.enqueue(new KeyFrame(matches![1]))
          //console.error(this.keyFrames[this.keyFrames.length - 1])
          //Deno.stdout.write(new TextEncoder().encode("."));
        }
        // remove the frame regardless of contents
        stringBuffer = stringBuffer.replace(frameRegEx, "");
      }
    },
    flush(){
      // new line to make the output prettier
      Deno.stdout.write(new TextEncoder().encode("\n"));
    }
  })

  /// this transform filters out keyframes as we only want a few to represent the chapter starts
  let lastFrameFiltered: KeyFrame;
  let lastFrameEncountered: KeyFrame;
  const keyFrameFilter = new TransformStream({
    transform(frame: KeyFrame, controller) {
      if (!lastFrameFiltered) {
        controller.enqueue(frame);
        lastFrameFiltered = frame;
      } else if ((frame.pts_time - lastFrameFiltered.pts_time) > chapterLength) {
        controller.enqueue(frame);
        lastFrameFiltered = frame;
      }
      lastFrameEncountered = frame;
    },
    flush(controller) {
      // include the last frame encountered if there was a chapter at the end that is short
      if (lastFrameFiltered !== lastFrameEncountered) {
        controller.enqueue(lastFrameEncountered)
      }
    }
  })

  /*
    Generate a chapter document/string transform that uses key frame start/end times. We can
    send this to the process below that will create the new video files;

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
  let firstFrame: KeyFrame;
  let lastChapterizedFrame: KeyFrame;
  let chapterizedCounter = 1; // starts a 1
  const chapterMetaDataTransform = new TransformStream({
    start(controller) {
      controller.enqueue(";FFMETADATA1\n");
    },
    transform(frame: KeyFrame, controller) {
      let chunk = "";

      // special case, we need the ending of the first chapter
      // to write the chapter metadata...
      if (!firstFrame) {
        firstFrame = frame;
        return;
      } 
      
      // write the first chapter now that we have the ending
      if (!lastChapterizedFrame) {
        chunk += `[CHAPTER]\n`;
        chunk += `TIMEBASE=1/1\n`;
        chunk += `START=0\n`;
        chunk += `END=${frame.pts_time}\n`;
        chunk += `title=Chapter 1\n`;
      } else {
        // write all the other chapters
        chunk += `[CHAPTER]\n`;
        chunk += `TIMEBASE=1/1\n`;
        chunk += `START=${lastChapterizedFrame.pts_time}\n`;
        chunk += `END=${frame.pts_time}\n`;
        chunk += `title=Chapter ${chapterizedCounter}\n`;
      }
      
      // bump counter and enqueue 
      chapterizedCounter++;
      controller.enqueue(chunk)

      // keep track of last frame chapterized
      lastChapterizedFrame = frame;      
    }
  });

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

    // get a transform stream with the filtered keyframes
    // get a transform stream proving the keyframes
    keyframeProcess.stdout.readable
      .pipeThrough(new TextDecoderStream)
      .pipeThrough(keyFrameCollector)
      .pipeThrough(keyFrameFilter)
      .pipeThrough(chapterMetaDataTransform)
      .pipeThrough(new TextEncoderStream())
      .pipeTo(chapterizeProcess.stdin.writable);

    // collect stderr of chapterizeProcess...
    let stderr = "";
  chapterizeProcess.stderr.readable.pipeTo(new WritableStream({
    write(chunk: Uint8Array) {
      stderr += new TextDecoder().decode(chunk);
    }
  })); 

  // if we don't await this the process will become defunct, should probably check it and print stderr too
  await keyframeProcess.status();

  // wait for processing to complete, throw error if there was an issue
  const promiseStatus = await chapterizeProcess.status();
  if (!promiseStatus.success) {
    const output = await chapterizeProcess.stderrOutput();
    throw new Error("could not write chapters, here's the stderr: \n" + chapterizeProcess.stderr);
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

