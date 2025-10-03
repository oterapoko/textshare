import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@13.6.10/+esm';
import { WebrtcProvider } from 'https://cdn.jsdelivr.net/npm/y-webrtc@10.2.5/+esm';
import { IndexeddbPersistence } from 'https://cdn.jsdelivr.net/npm/y-indexeddb@9.0.12/+esm';

// Global variables
let currentProvider = null;
let currentDoc = null;
let currentYText = null;
let yjsErrorCount = 0;
let yjsDisabled = false;

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
  
  // Multi-layer persistence: IndexedDB + localStorage fallback
  console.log('Setting up persistence layers...');
  let indexeddbProvider = null;
  let persistenceReady = false;
  
  // Try IndexedDB first
  try {
    indexeddbProvider = new IndexeddbPersistence(`textshare-${roomId}`, ydoc);
    console.log('IndexedDB provider created');
  } catch (error) {
    console.warn('IndexedDB failed, will use localStorage fallback:', error);
  }
  
  // localStorage fallback for mobile browsers
  const localStorageKey = `textshare-${roomId}`;
  
  // Load from localStorage immediately (faster than IndexedDB)
  const savedTextFromLS = localStorage.getItem(localStorageKey);
  if (savedTextFromLS) {
    console.log('Found saved text in localStorage:', savedTextFromLS.length, 'characters');
    ytext.insert(0, savedTextFromLS);
    textarea.value = savedTextFromLS;
    updateCharCount();
  }
  
  // Promise to wait for persistence to be ready
  const indexedDBReady = new Promise((resolve) => {
    if (indexeddbProvider) {
      // Set a timeout in case IndexedDB never syncs (common on mobile)
      const timeout = setTimeout(() => {
        console.warn('IndexedDB sync timeout, using localStorage only');
        persistenceReady = true;
        resolve();
      }, 3000); // 3 second timeout
      
      indexeddbProvider.on('synced', () => {
        clearTimeout(timeout);
        console.log('IndexedDB synced successfully');
        const savedText = ytext.toString();
        if (savedText && savedText !== savedTextFromLS) {
          console.log('IndexedDB has newer text:', savedText.length, 'characters');
          if (textarea.value !== savedText) {
            textarea.value = savedText;
            updateCharCount();
          }
        }
        persistenceReady = true;
        resolve();
      });
    } else {
      // No IndexedDB, use localStorage only
      console.log('Using localStorage-only persistence');
      persistenceReady = true;
      resolve();
    }
  });
  
  // Wait for IndexedDB to be ready before setting up WebRTC
  await indexedDBReady;
  
  // Try WebRTC provider with fallback to local-only mode
  console.log('Setting up WebRTC provider...');
  let webrtcProvider = null;
  
  try {
    webrtcProvider = new WebrtcProvider(`textshare-${roomId}`, ydoc, {
      signaling: [
        'wss://signaling.yjs.dev',
        'wss://y-webrtc-signaling-eu.herokuapp.com',
        'wss://y-webrtc-signaling-us.herokuapp.com'
      ],
      maxConns: 10,
      filterBcConns: true,
      peerOpts: {
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
          ]
        }
      }
    });
    console.log('WebRTC provider created with signaling servers');
  } catch (error) {
    console.warn('WebRTC provider failed to initialize:', error);
    webrtcProvider = null;
  }
  
  currentProvider = webrtcProvider;
  
  // BroadcastChannel fallback for same-device multi-tab sync
  let broadcastChannel = null;
  if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel(`textshare-${roomId}`);
    
    // Listen for messages from other tabs
    broadcastChannel.addEventListener('message', (event) => {
      if (event.data.type === 'text-update' && event.data.text !== ytext.toString()) {
        console.log('Received text update from another tab via BroadcastChannel');
        updatingFromYjs = true;
        const cursorPos = textarea.selectionStart;
        textarea.value = event.data.text;
        ytext.delete(0, ytext.length);
        ytext.insert(0, event.data.text);
        textarea.setSelectionRange(cursorPos, cursorPos);
        updateCharCount();
        updatingFromYjs = false;
      } else if (event.data.type === 'peer-join') {
        console.log('Peer joined via BroadcastChannel');
        // Simulate peer awareness for local tabs
        peerCount = Math.max(peerCount, 1);
        if (peerCountElement) {
          peerCountElement.textContent = peerCount.toString();
        }
        updateConnectionStatus('connected', peerCount);
      }
    });
    
    // Announce presence to other tabs
    broadcastChannel.postMessage({ type: 'peer-join', userId: 'user-' + Math.random().toString(36).substr(2, 8) });
    
    console.log('BroadcastChannel fallback enabled for same-device sync');
  }
  
  // Peer count tracking
  let peerCount = 0;
  const updatePeerCount = () => {
    if (webrtcProvider && webrtcProvider.awareness) {
      const states = webrtcProvider.awareness.getStates();
      peerCount = Math.max(0, states.size - 1);
    } else {
      peerCount = 0;
    }
    
    if (peerCountElement) {
      peerCountElement.textContent = peerCount.toString();
    }
    
    console.log('Peer count updated:', peerCount);
    updateConnectionStatus(peerCount > 0 ? 'connected' : 'disconnected', peerCount);
  };
  
  // Text synchronization: Yjs -> Textarea
  let updatingFromYjs = false;
  ytext.observe((event, transaction) => {
    // Skip if we're currently updating, or if this is our own local update
    if (updatingFromYjs || updatingFromTextarea || transaction.origin === 'local-update') {
      return;
    }
    
    const ytextValue = ytext.toString();
    
    // Only update if the content is actually different
    if (textarea.value !== ytextValue) {
      updatingFromYjs = true;
      console.log('Yjs text changed from remote, updating textarea:', ytextValue.length, 'characters');
      
      const cursorPos = textarea.selectionStart;
      const scrollPos = textarea.scrollTop;
      
      textarea.value = ytextValue;
      
      // Restore cursor position
      if (cursorPos <= ytextValue.length) {
        textarea.setSelectionRange(cursorPos, cursorPos);
      }
      textarea.scrollTop = scrollPos;
      updateCharCount();
      
      setTimeout(() => {
        updatingFromYjs = false;
      }, 10);
    }
  });
  
  // Text synchronization: Textarea -> Yjs
  let updatingFromTextarea = false;
  let inputTimeout = null;
  
  const syncTextareaToYjs = () => {
    if (updatingFromTextarea || updatingFromYjs) return;
    
    const currentText = ytext.toString();
    const newText = textarea.value;
    
    // Only sync if there's actually a difference
    if (currentText !== newText) {
      updatingFromTextarea = true;
      console.log('Updating Yjs from textarea:', newText.length, 'characters');
      
      // Only try Yjs if it's not disabled due to errors
      if (!yjsDisabled) {
        try {
          // Use a safer approach: apply diff instead of delete/insert all
          ydoc.transact(() => {
            // Find the differences and apply minimal changes
            const minLength = Math.min(currentText.length, newText.length);
            let startDiff = 0;
            let endDiff = 0;
            
            // Find start of difference
            while (startDiff < minLength && currentText[startDiff] === newText[startDiff]) {
              startDiff++;
            }
            
            // Find end of difference
            while (endDiff < minLength - startDiff && 
                   currentText[currentText.length - 1 - endDiff] === newText[newText.length - 1 - endDiff]) {
              endDiff++;
            }
            
            // Calculate what to delete and insert
            const deleteLength = currentText.length - startDiff - endDiff;
            const insertText = newText.slice(startDiff, newText.length - endDiff);
            
            // Apply the minimal changes
            if (deleteLength > 0) {
              ytext.delete(startDiff, deleteLength);
            }
            if (insertText.length > 0) {
              ytext.insert(startDiff, insertText);
            }
          }, 'local-update');
          
        } catch (error) {
          yjsErrorCount++;
          console.warn(`Yjs sync error #${yjsErrorCount}:`, error);
          
          // If we get too many errors, disable Yjs completely
          if (yjsErrorCount >= 5) {
            yjsDisabled = true;
            console.warn('Too many Yjs errors, disabling Yjs sync. Using localStorage + BroadcastChannel only.');
            showToast('Switched to local-only mode due to sync issues', 'error');
          }
        }
      }
      
      // Save to localStorage for mobile browser compatibility
      try {
        localStorage.setItem(localStorageKey, newText);
      } catch (error) {
        console.warn('localStorage save failed:', error);
      }
      
      // Also broadcast via BroadcastChannel for same-device sync
      if (broadcastChannel) {
        broadcastChannel.postMessage({ 
          type: 'text-update', 
          text: newText,
          timestamp: Date.now()
        });
      }
      
      updateCharCount();
      
      // Reset flag after a short delay
      setTimeout(() => {
        updatingFromTextarea = false;
      }, 50);
    }
  };
  
  textarea.addEventListener('input', () => {
    clearTimeout(inputTimeout);
    inputTimeout = setTimeout(syncTextareaToYjs, 50); // Faster sync
  });
  
  // WebRTC events (only if provider exists)
  if (webrtcProvider) {
    // WebRTC events with better error handling
    webrtcProvider.on('status', (event) => {
      console.log('WebRTC status changed:', event.status);
      if (event.status === 'connected') {
        updateConnectionStatus('connected', peerCount);
        showToast('🌐 Connected! Ready for cross-device collaboration');
      } else if (event.status === 'connecting') {
        updateConnectionStatus('connecting', peerCount);
        console.log('WebRTC connecting to signaling servers...');
      } else {
        updateConnectionStatus('disconnected', peerCount);
        console.log('WebRTC disconnected, using local-only mode');
      }
    });
    
    // Handle WebRTC connection errors
    webrtcProvider.on('connection-error', (error) => {
      console.error('WebRTC connection error:', error);
      showToast('Connection issues - using local mode...', 'error');
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
    // Set a timeout to detect if signaling servers are not responding
    let signalingTimeout = setTimeout(() => {
      console.warn('Signaling servers not responding after 10 seconds');
      updateConnectionStatus('disconnected', 0);
      showToast('⚠️ Internet sync unavailable - working in local mode', 'error');
    }, 10000);
    
    // Clear timeout if WebRTC connects successfully
    webrtcProvider.on('status', (event) => {
      if (event.status === 'connected') {
        clearTimeout(signalingTimeout);
      }
    });
    
  } else {
    // No WebRTC - show local-only mode immediately
    console.log('WebRTC not available - running in local-only mode');
    updateConnectionStatus('disconnected', 0);
    showToast('Running in local-only mode - text will be saved locally', 'error');
  }
  
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
