'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, typed API to the renderer process
contextBridge.exposeInMainWorld('tracker', {
  // ── SimConnect ──
  connect:    () => ipcRenderer.send('simconnect:connect'),
  disconnect: () => ipcRenderer.send('simconnect:disconnect'),

  // ── Tracking ──
  startTracking: () => ipcRenderer.send('tracking:start'),
  stopTracking:  () => ipcRenderer.send('tracking:stop'),

  // ── Settings ──
  loadSettings: ()           => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings)   => ipcRenderer.invoke('settings:save', settings),

  // ── API ──
  submitFlight:  (record)    => ipcRenderer.invoke('api:submitFlight', record),
  verifyToken:   ()          => ipcRenderer.invoke('api:verifyToken'),

  // ── Window controls ──
  minimizeWindow: ()  => ipcRenderer.send('window:minimize'),
  maximizeWindow: ()  => ipcRenderer.send('window:maximize'),
  closeWindow:    ()  => ipcRenderer.send('window:close'),

  // ── App info ──
  getVersion:  ()     => ipcRenderer.invoke('app:version'),
  getState:    ()     => ipcRenderer.invoke('app:getState'),

  // ── Utilities ──
  openExternal: (url) => ipcRenderer.send('open:external', url),

  // ── Event listeners (main → renderer) ──
  on: (channel, callback) => {
    const allowed = [
      'simconnect:status',
      'flight:data',
      'flight:phase',
      'flight:event',
      'flight:complete',
      'api:submit',
    ];
    if (allowed.includes(channel)) {
      const listener = (_, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
    return () => {};
  },

  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
});
