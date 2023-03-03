export class EasySink implements UnderlyingSink {

  asWritableStream(): WritableStream {
    return new WritableStream(this);
  }

  start: WritableStreamDefaultControllerStartCallback = () => {};

  onStart(start: WritableStreamDefaultControllerStartCallback) {
    this.start = start;
  }

  write: WritableStreamDefaultControllerWriteCallback<Uint8Array> = () => {};

  onWrite(write: WritableStreamDefaultControllerWriteCallback<Uint8Array>)
  {
    this.write = write;
  }

  close: WritableStreamDefaultControllerCloseCallback = () => {};

  onClose(close: WritableStreamDefaultControllerCloseCallback) {
    this.close = close;
  }

  abort: WritableStreamErrorCallback = () => {};

  onAbort(abort: WritableStreamErrorCallback) {
    this.abort = abort; 
  }

}

