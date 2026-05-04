import { afterEach } from 'bun:test';
import { Window } from 'happy-dom';

const windowInstance = new Window({
  url: 'http://localhost/',
  width: 1280,
  height: 720,
});

const assignGlobal = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
};

const installCanvasAndImageMocks = () => {
  const canvasPrototype = windowInstance.HTMLCanvasElement.prototype as HTMLCanvasElement & {
    getContext?: (contextId: string) => CanvasRenderingContext2D | null;
    toBlob?: (
      callback: BlobCallback,
      type?: string,
      quality?: number,
    ) => void;
  };

  Object.defineProperty(canvasPrototype, 'getContext', {
    configurable: true,
    writable: true,
    value: (contextId: string) => {
      if (contextId !== '2d') {
        return null;
      }

      return {
        clearRect: () => undefined,
        drawImage: () => undefined,
      } as unknown as CanvasRenderingContext2D;
    },
  });

  Object.defineProperty(canvasPrototype, 'toBlob', {
    configurable: true,
    writable: true,
    value: (callback: BlobCallback, type?: string) => {
      callback(new windowInstance.Blob([''], { type: type ?? 'image/png' }));
    },
  });

  class ImageMock {
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private currentSrc = '';

    get src(): string {
      return this.currentSrc;
    }

    set src(value: string) {
      this.currentSrc = value;
      queueMicrotask(() => {
        this.onload?.(new windowInstance.Event('load'));
      });
    }
  }

  assignGlobal('Image', ImageMock as unknown as typeof windowInstance.Image);

  const urlConstructor = globalThis.URL as typeof URL & {
    createObjectURL?: (object: unknown) => string;
    revokeObjectURL?: (url: string) => void;
  };

  Object.defineProperty(urlConstructor, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => 'blob:mock-url',
  });

  Object.defineProperty(urlConstructor, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
};

const installDomGlobals = () => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  for (const [key, value] of [
    ['Error', Error],
    ['RangeError', RangeError],
    ['ReferenceError', ReferenceError],
    ['SyntaxError', SyntaxError],
    ['TypeError', TypeError],
  ] as const) {
    Object.defineProperty(windowInstance, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  assignGlobal('window', windowInstance);
  assignGlobal('document', windowInstance.document);
  assignGlobal('navigator', windowInstance.navigator);
  assignGlobal('location', windowInstance.location);
  assignGlobal('history', windowInstance.history);
  assignGlobal('localStorage', windowInstance.localStorage);
  assignGlobal('sessionStorage', windowInstance.sessionStorage);
  assignGlobal('requestAnimationFrame', windowInstance.requestAnimationFrame.bind(windowInstance));
  assignGlobal('cancelAnimationFrame', windowInstance.cancelAnimationFrame.bind(windowInstance));
  assignGlobal('getComputedStyle', windowInstance.getComputedStyle.bind(windowInstance));
  assignGlobal('HTMLElement', windowInstance.HTMLElement);
  assignGlobal('HTMLInputElement', windowInstance.HTMLInputElement);
  assignGlobal('HTMLTextAreaElement', windowInstance.HTMLTextAreaElement);
  assignGlobal('HTMLCanvasElement', windowInstance.HTMLCanvasElement);
  assignGlobal('SVGElement', windowInstance.SVGElement);
  assignGlobal('Node', windowInstance.Node);
  assignGlobal('EventTarget', windowInstance.EventTarget);
  assignGlobal('Event', windowInstance.Event);
  assignGlobal('CustomEvent', windowInstance.CustomEvent);
  assignGlobal('FocusEvent', windowInstance.FocusEvent);
  assignGlobal('InputEvent', windowInstance.InputEvent);
  assignGlobal('MouseEvent', windowInstance.MouseEvent);
  assignGlobal('KeyboardEvent', windowInstance.KeyboardEvent);
  assignGlobal('PointerEvent', windowInstance.PointerEvent);
  assignGlobal('MutationObserver', windowInstance.MutationObserver);
  assignGlobal('Blob', windowInstance.Blob);
  assignGlobal('File', windowInstance.File);
  assignGlobal('Image', windowInstance.Image);
  assignGlobal('ResizeObserver', ResizeObserverMock);

  installCanvasAndImageMocks();
};

installDomGlobals();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  installDomGlobals();
  Reflect.deleteProperty(windowInstance as Window & { __TAURI__?: unknown }, '__TAURI__');
  Reflect.deleteProperty(windowInstance as Window & { __TAURI_INTERNALS__?: unknown }, '__TAURI_INTERNALS__');
  windowInstance.document.body.innerHTML = '';
  windowInstance.localStorage.clear();
  windowInstance.sessionStorage.clear();
});

export {};
