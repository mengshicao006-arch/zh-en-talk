const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__ZH_EN_ELECTRON__', true);

contextBridge.exposeInMainWorld('talk', {
  getApiKey: () => ipcRenderer.invoke('config:get-key'),
  setApiKey: (apiKey) => ipcRenderer.invoke('config:set-key', apiKey),
  getDoubaoKey: () => ipcRenderer.invoke('config:get-doubao'),
  setDoubaoKey: (apiKey) => ipcRenderer.invoke('config:set-doubao', apiKey),
  getDoubaoSpeaker: () => ipcRenderer.invoke('config:get-speaker'),
  setDoubaoSpeaker: (speaker) => ipcRenderer.invoke('config:set-speaker', speaker),
  getDoubaoTtsKey: () => ipcRenderer.invoke('config:get-tts-key'),
  setDoubaoTtsKey: (apiKey) => ipcRenderer.invoke('config:set-tts-key', apiKey),
  getTtsVoices: () => ipcRenderer.invoke('config:get-tts-voices'),
  setTtsVoice: (lang, voice) => ipcRenderer.invoke('config:set-tts-voice', lang, voice),
  translate: (text) => ipcRenderer.invoke('translate', text),
  transcribe: (pcm) => ipcRenderer.invoke('asr:transcribe', pcm),
  ttsReady: () => ipcRenderer.invoke('tts:ready'),
  ttsStatus: () => ipcRenderer.invoke('tts:status'),
  tts: (text, lang) => ipcRenderer.invoke('tts:generate', text, lang),
  onTtsStatus: (callback) => {
    ipcRenderer.on('tts:status', (_event, text) => callback(text));
  },
  getPhoneShare: () => ipcRenderer.invoke('phone:info'),
  onPhoneShare: (callback) => {
    ipcRenderer.on('phone:info', (_event, info) => callback(info));
  },
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
