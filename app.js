import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@latest/+esm';
import { WebrtcProvider } from 'https://cdn.jsdelivr.net/npm/y-webrtc@latest/+esm';
import { IndexeddbPersistence } from 'https://cdn.jsdelivr.net/npm/y-indexeddb@latest/+esm';

// Global variables
let currentProvider = null;
let currentDoc = null;
let currentYText = null;

// Generate cryptographically secure room ID
function generateRoomId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => 
    byte.toString(16).padStart(2, '0')
  ).join('').substring(0, 12);
}

// Show toast notification
function showToast(message, type = 'success') {
  const bgColor = type === 'success' ? 'bg-green-500' : 'bg-red-500';
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 ${bgColor} text-white px-6 py-3 rounded-lg shadow-lg transition-opacity duration-300 z-50`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Copy to clipboard
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Link copied to clipboard!');
  } catch (err) {
    // Fallback for older browsers
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Link copied!');
  }
}

// Update character count
function updateCharCount() {
  const textarea = document.getElementById('editor');
  const charCount = document.getElementById('char-count');
  if (textarea && charCount) {
    charCount.textContent = textarea.value.length;
  }
}

// Update connection status
function updateConnectionStatus(status, peerCount = 0) {
  const statusElement = document.getElementById('connection-status');
  const indicator = document.getElementById('status-indicator');
  
  if (!statusElement || !indicator) return;
  
  let statusText = '';
  let indicatorClass = '';
  
  switch (status) {
    case 'connecting':
      statusText = 'Connecting...';
      indicatorClass = 'bg-yellow-400';
      break;
    case 'connected':
      statusText = peerCount > 0 ? `Connected (${peerCount} peers)` : 'Connected';
      indicatorClass = 'bg-green-500';
      break;
    case 'disconnected':
      statusText = 'Offline';
      indicatorClass = 'bg-red-500';
      break;
    default:
      statusText = 'Unknown';
      indicatorClass = 'bg-gray-400';
  }
  
  statusElement.querySelector('span').textContent = statusText;
  indicator.className = `w-2 h-2 rounded-full ${indicatorClass}`;
}

// Initialize Yjs for a room
async function initializeYjs(roomId) {
  console.log('Initializing Yjs for room:', roomId);
  
  // Clean up previous connections
  if (currentProvider) {
    console.log('Destroying previous provider');
    currentProvider.destroy();
    currentProvider = null;
  }
  
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('shared-text');
  
  // Store references
  currentDoc = ydoc;
  currentYText = ytext;
  
  const textarea = document.getElementById('editor');
  const peerCountElement = document.getElementById('peer-count');
  
  if (!textarea) {
    console.error('Editor textarea not found');
    return;
  }
  
  // Initialize UI
  if (peerCountElement) {
    peerCountElement.textContent = '0';
  }
  updateConnectionStatus('connecting', 0);
  
  // IndexedDB persistence - CRITICAL: Wait for it to sync first
  console.log('Setting up IndexedDB persistence...');
  const indexeddbProvider = new IndexeddbPersistence(`textshare-${roomId}`, ydoc);
  
  // Promise to wait for IndexedDB to be ready
  const indexedDBReady = new Promise((resolve) => {
    indexeddbProvider.on('synced', () => {
      console.log('IndexedDB synced successfully');
      const savedText = ytext.toString();
      if (savedText) {
        console.log('Found saved text:', savedText.length, 'characters');
        if (textarea.value !== savedText) {
          textarea.value = savedText;
          updateCharCount();
        }
      } else {
        console.log('No saved text found in IndexedDB');
      }
      resolve();
    });
  });
  
  // Wait for IndexedDB to be ready before setting up WebRTC
  await indexedDBReady;
  
  // WebRTC provider for P2P sync
  console.log('Setting up WebRTC provider...');
  const webrtcProvider = new WebrtcProvider(`textshare-${roomId}`, ydoc, {
    signaling: [
      'wss://signaling.yjs.dev',
      'wss://y-webrtc-signaling-eu.herokuapp.com',
      'wss://y-webrtc-signaling-us.herokuapp.com'
    ],
    maxConns: 20,
    filterBcConns: true,
    peerOpts: {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    }
  });
  
  currentProvider = webrtcProvider;
  
  // Peer count tracking
  let peerCount = 0;
  const updatePeerCount = () => {
    const states = webrtcProvider.awareness.getStates();
    peerCount = Math.max(0, states.size - 1);
    
    if (peerCountElement) {
      peerCountElement.textContent = peerCount.toString();
    }
    
    console.log('Peer count updated:', peerCount, '(total awareness states:', states.size, ')');
    updateConnectionStatus(peerCount > 0 ? 'connected' : 'connecting', peerCount);
  };
  
  // Text synchronization: Yjs -> Textarea
  let updatingFromYjs = false;
  ytext.observe((event, transaction) => {
    if (updatingFromYjs) return;
    
    const ytextValue = ytext.toString();
    console.log('Yjs text changed, new length:', ytextValue.length);
    
    if (textarea.value !== ytextValue) {
      updatingFromYjs = true;
      const cursorPos = textarea.selectionStart;
      const scrollPos = textarea.scrollTop;
      
      textarea.value = ytextValue;
      
      // Restore cursor position
      if (cursorPos <= ytextValue.length) {
        textarea.setSelectionRange(cursorPos, cursorPos);
      }
      textarea.scrollTop = scrollPos;
      updateCharCount();
      
      console.log('Updated textarea from Yjs:', ytextValue.length, 'characters');
      updatingFromYjs = false;
    }
  });
  
  // Text synchronization: Textarea -> Yjs
  let updatingFromTextarea = false;
  let inputTimeout = null;
  
  const syncTextareaToYjs = () => {
    if (updatingFromTextarea || updatingFromYjs) return;
    
    const currentText = ytext.toString();
    const newText = textarea.value;
    
    if (currentText !== newText) {
      updatingFromTextarea = true;
      console.log('Updating Yjs from textarea:', newText.length, 'characters');
      
      ydoc.transact(() => {
        ytext.delete(0, currentText.length);
        ytext.insert(0, newText);
      });
      
      updatingFromTextarea = false;
      updateCharCount();
    }
  };
  
  textarea.addEventListener('input', () => {
    clearTimeout(inputTimeout);
    inputTimeout = setTimeout(syncTextareaToYjs, 50); // Faster sync
  });
  
  // WebRTC events
  webrtcProvider.on('status', (event) => {
    console.log('WebRTC status changed:', event.status);
    if (event.status === 'connected') {
      updateConnectionStatus('connected', peerCount);
    } else if (event.status === 'connecting') {
      updateConnectionStatus('connecting', peerCount);
    } else {
      updateConnectionStatus('disconnected', peerCount);
    }
  });
  
  // Awareness events (peer tracking)
  webrtcProvider.awareness.on('change', (changes) => {
    console.log('Awareness changed:', {
      added: changes.added,
      updated: changes.updated,
      removed: changes.removed
    });
    updatePeerCount();
  });
  
  // Peer connection events
  webrtcProvider.on('peers', (event) => {
    console.log('Peers event:', event);
    updatePeerCount();
  });
  
  // Document sync events
  webrtcProvider.on('synced', () => {
    console.log('WebRTC document synced');
    updatePeerCount();
  });
  
  // Set user awareness (helps with peer detection)
  const userId = 'user-' + Math.random().toString(36).substr(2, 8);
  webrtcProvider.awareness.setLocalStateField('user', {
    name: userId,
    color: '#' + Math.floor(Math.random()*16777215).toString(16),
    timestamp: Date.now()
  });
  
  console.log('Set user awareness:', userId);
  
  // Initial UI setup
  setTimeout(() => {
    textarea.focus();
    updateCharCount();
    updatePeerCount();
    console.log('Yjs initialization complete for room:', roomId);
  }, 100);
}

// Router function
async function handleRoute() {
  const hash = window.location.hash;
  
  if (hash.startsWith('#room-')) {
    const roomId = hash.substring(6);
    
    // Validate room ID (should be 12 character hex)
    if (!/^[a-f0-9]{12}$/i.test(roomId)) {
      console.error('Invalid room ID format');
      window.location.hash = '';
      return;
    }
    
    document.getElementById('landing').classList.add('hidden');
    document.getElementById('editor-container').classList.remove('hidden');
    
    // Initialize Yjs with proper async handling
    try {
      await initializeYjs(roomId);
    } catch (error) {
      console.error('Failed to initialize Yjs:', error);
      // Show error to user
      showToast('Failed to initialize room. Please try again.', 'error');
    }
  } else {
    // Clean up connections when leaving editor
    if (currentProvider) {
      console.log('Cleaning up provider on route change');
      currentProvider.destroy();
      currentProvider = null;
    }
    
    document.getElementById('landing').classList.remove('hidden');
    document.getElementById('editor-container').classList.add('hidden');
  }
}

// Keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S to copy link (prevent default save)
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (window.location.hash.startsWith('#room-')) {
        copyToClipboard(window.location.href);
      }
    }
    
    // Escape to go back to home
    if (e.key === 'Escape' && window.location.hash.startsWith('#room-')) {
      window.location.hash = '';
    }
  });
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  console.log('TextShare initializing...');
  
  // Create new document button
  const createBtn = document.getElementById('create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const roomId = generateRoomId();
      window.location.hash = `room-${roomId}`;
    });
  }
  
  // Copy link button
  const copyBtn = document.getElementById('copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      copyToClipboard(window.location.href);
    });
  }
  
  // Setup keyboard shortcuts
  setupKeyboardShortcuts();
  
  // Router setup
  window.addEventListener('hashchange', handleRoute);
  
  // Handle initial route
  handleRoute();
  
  // Service worker registration (for future PWA support)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Could register a service worker here for offline support
      console.log('Service worker support detected');
    });
  }
  
  console.log('TextShare initialized successfully');
});

// Handle page visibility changes (pause/resume connections)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('Page hidden - connections may be paused');
  } else {
    console.log('Page visible - resuming connections');
  }
});

// Handle beforeunload (cleanup)
window.addEventListener('beforeunload', () => {
  if (currentProvider) {
    currentProvider.destroy();
  }
});

// Export functions for debugging (development only)
if (typeof window !== 'undefined') {
  window.TextShareDebug = {
    generateRoomId,
    getCurrentDoc: () => currentDoc,
    getCurrentYText: () => currentYText,
    getCurrentProvider: () => currentProvider
  };
}
