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

const installDomGlobals = () => {
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
  assignGlobal('MutationObserver', windowInstance.MutationObserver);
  assignGlobal('Blob', windowInstance.Blob);
  assignGlobal('File', windowInstance.File);
  assignGlobal('Image', windowInstance.Image);
};

installDomGlobals();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  installDomGlobals();
  windowInstance.document.body.innerHTML = '';
  windowInstance.localStorage.clear();
  windowInstance.sessionStorage.clear();
});

export {};
