// Administra productos, códigos de barras y existencias en IndexedDB.
const DB_NAME = 'inventario-local-db';
const DB_VERSION = 2;
const STORE_NAME = 'productos';
const form = document.querySelector('#product-form');
const nameInput = document.querySelector('#product-name');
const barcodeInput = document.querySelector('#product-barcode');
const quantityInput = document.querySelector('#product-quantity');
const voiceButton = document.querySelector('#voice-button');
const voiceButtonLabel = document.querySelector('#voice-button-label');
const voiceStatus = document.querySelector('#voice-status');
const searchInput = document.querySelector('#search-input');
const list = document.querySelector('#product-list');
const emptyState = document.querySelector('#empty-state');
const emptyTitle = document.querySelector('#empty-title');
const emptyDescription = document.querySelector('#empty-description');
const notice = document.querySelector('#notice');
const editDialog = document.querySelector('#edit-dialog');
const stockDialog = document.querySelector('#stock-dialog');
const scannerDialog = document.querySelector('#scanner-dialog');
const scannerVideo = document.querySelector('#scanner-video');
const scannerStatus = document.querySelector('#scanner-status');
let db;
let products = [];
let noticeTimer;
let cameraStream;
let scanFrame;
let scanBusy = false;
let scannerTarget;
let speechRecognition;
let speechActive = false;
let speechCancelled = false;

function setVoiceStatus(message, isError = false) {
  voiceStatus.textContent = message;
  voiceStatus.classList.toggle('error-text', isError);
  voiceStatus.hidden = !message;
}

function stopVoiceRecognition(cancel = false) {
  if (!speechRecognition || !speechActive) return;
  speechCancelled = cancel;
  if (cancel) speechRecognition.abort();
  else speechRecognition.stop();
  setVoiceStatus(cancel ? 'Dictado cancelado.' : 'Finalizando el dictado…');
}

function startVoiceRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setVoiceStatus('Este navegador no admite dictado por voz. Escribe el nombre manualmente.', true);
    return;
  }
  if (!window.isSecureContext) {
    setVoiceStatus('El dictado requiere HTTPS o localhost. Puedes escribir el nombre manualmente.', true);
    return;
  }
  speechRecognition = new Recognition();
  speechRecognition.lang = 'es-CO';
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechCancelled = false;
  speechRecognition.onstart = () => {
    speechActive = true;
    voiceButton.setAttribute('aria-pressed', 'true');
    voiceButton.setAttribute('aria-label', 'Detener dictado');
    voiceButtonLabel.textContent = 'Detener';
    setVoiceStatus('Escuchando… Habla ahora.');
  };
  speechRecognition.onresult = event => {
    if (speechCancelled) return;
    const transcript = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript).join(' ').trim();
    if (transcript) {
      nameInput.value = cleanName(transcript);
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      setVoiceStatus(`Nombre reconocido: ${nameInput.value}`);
    } else setVoiceStatus('No se reconocieron palabras. Inténtalo de nuevo.', true);
  };
  speechRecognition.onerror = event => {
    const messages = {
      'not-allowed': 'No se concedió permiso para usar el micrófono. Revisa los permisos del navegador.',
      'service-not-allowed': 'El navegador no permite usar el servicio de reconocimiento de voz.',
      'no-speech': 'No se detectó voz. Inténtalo de nuevo en un lugar más silencioso.',
      'audio-capture': 'No se encontró un micrófono disponible.',
      'network': 'Falló la conexión necesaria para reconocer la voz. Revisa internet e inténtalo de nuevo.',
      'language-not-supported': 'El reconocimiento de español de Colombia no está disponible en este navegador.',
      'aborted': speechCancelled ? 'Dictado cancelado.' : 'El dictado se detuvo.'
    };
    setVoiceStatus(messages[event.error] || 'Ocurrió un error al reconocer la voz. Puedes escribir el nombre manualmente.', true);
  };
  speechRecognition.onend = () => {
    speechActive = false;
    voiceButton.setAttribute('aria-pressed', 'false');
    voiceButton.setAttribute('aria-label', 'Dictar nombre del producto');
    voiceButtonLabel.textContent = 'Dictar';
    speechRecognition = undefined;
  };
  setVoiceStatus('Solicitando acceso al micrófono…');
  try { speechRecognition.start(); }
  catch {
    speechRecognition = undefined;
    setVoiceStatus('No se pudo iniciar el dictado. Espera un momento e inténtalo de nuevo.', true);
  }
}

voiceButton.addEventListener('click', () => {
  if (speechActive) stopVoiceRecognition();
  else startVoiceRecognition();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && speechActive) stopVoiceRecognition(true);
});

function normalizeText(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

function cleanName(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function cleanBarcode(value) {
  return value.trim();
}

function barcodeKey(value) {
  return cleanBarcode(value).toLocaleUpperCase('en-US');
}

function validInteger(value, minimum = 0) {
  if (value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) return null;
  return Number(value);
}

function withBarcodeKey(product) {
  const result = { ...product };
  result.nameKey = normalizeText(result.name);
  const key = barcodeKey(result.barcode || '');
  if (key) result.barcodeKey = key;
  else delete result.barcodeKey;
  return result;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('Este navegador no permite guardar datos locales.'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      if (!store.indexNames.contains('nameKey')) store.createIndex('nameKey', 'nameKey', { unique: true });
      if (!store.indexNames.contains('barcodeKey')) store.createIndex('barcodeKey', 'barcodeKey', { unique: true });
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        cursor.update({ ...cursor.value, nameKey: normalizeText(cursor.value.name) });
        cursor.continue();
      };
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la base de datos.'));
    request.onblocked = () => reject(new Error('Cierra otras pestañas de esta app e inténtalo de nuevo.'));
  });
}

function storeRequest(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo guardar el cambio.'));
    transaction.onabort = () => reject(transaction.error || new Error('El cambio no se completó.'));
  });
}

async function loadProducts() {
  products = await storeRequest('readonly', store => store.getAll());
  products.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  render();
}

function showNotice(message, isError = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

function render() {
  const query = normalizeText(searchInput.value);
  const filtered = products.filter(product => normalizeText(`${product.name} ${product.barcode || ''}`).includes(query));
  const units = products.reduce((total, product) => total + product.quantity, 0);
  document.querySelector('#product-count').textContent = products.length;
  document.querySelector('#unit-count').textContent = units.toLocaleString('es');
  document.querySelector('#visible-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'producto' : 'productos'}`;
  list.replaceChildren();
  filtered.forEach(product => list.append(createProductRow(product)));
  const noProducts = products.length === 0;
  emptyState.hidden = filtered.length > 0;
  emptyTitle.textContent = noProducts ? 'Aún no hay productos' : 'No encontramos coincidencias';
  emptyDescription.textContent = noProducts ? 'Agrega tu primer producto para comenzar a llevar el control.' : 'Prueba con otro nombre o código de barras.';
}

function createAction(label, action, className, id, accessibleLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `text-action ${className}`;
  button.dataset.action = action;
  button.dataset.id = id;
  button.setAttribute('aria-label', accessibleLabel);
  button.textContent = label;
  return button;
}

function createProductRow(product) {
  const row = document.createElement('tr');
  const nameCell = document.createElement('td');
  const productCell = document.createElement('div');
  productCell.className = 'product-cell';
  const avatar = document.createElement('span');
  avatar.className = 'product-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = product.name.charAt(0).toLocaleUpperCase('es');
  const details = document.createElement('span');
  details.className = 'product-details';
  const name = document.createElement('span');
  name.className = 'product-name';
  name.textContent = product.name;
  const barcode = document.createElement('span');
  barcode.className = `product-barcode${product.barcode ? '' : ' missing-barcode'}`;
  barcode.textContent = product.barcode || 'Sin código';
  details.append(name, barcode);
  productCell.append(avatar, details);
  nameCell.append(productCell);
  const quantityCell = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = `quantity-pill${product.quantity <= 3 ? ' low' : ''}`;
  pill.textContent = product.quantity.toLocaleString('es');
  pill.setAttribute('aria-label', `${product.quantity} unidades`);
  quantityCell.append(pill);
  const actionsCell = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.append(
    createAction('+ Sumar', 'stock', 'add-action', product.id, `Sumar existencias de ${product.name}`),
    createAction('Editar', 'edit', '', product.id, `Editar ${product.name}`),
    createAction('Eliminar', 'delete', 'delete-action', product.id, `Eliminar ${product.name}`)
  );
  actionsCell.append(actions);
  row.append(nameCell, quantityCell, actionsCell);
  return row;
}

function hasDuplicateName(name, ignoredId = null) {
  return products.some(product => product.id !== ignoredId && normalizeText(product.name) === normalizeText(name));
}

function hasDuplicateBarcode(value, ignoredId = null) {
  const key = barcodeKey(value);
  return Boolean(key) && products.some(product => product.id !== ignoredId && barcodeKey(product.barcode || '') === key);
}

function showSaveError(error) {
  if (error && error.name === 'ConstraintError') showNotice('Ese código de barras ya está asignado a otro producto.', true);
  else showNotice(error.message || 'No se pudo guardar el cambio.', true);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const name = cleanName(nameInput.value);
  const barcode = cleanBarcode(barcodeInput.value);
  const quantity = validInteger(quantityInput.value);
  if (!name) return showNotice('Escribe el nombre del producto.', true);
  if (!barcode) return showNotice('Escribe o escanea el código de barras del producto.', true);
  if (quantity === null) return showNotice('La cantidad debe ser un número entero igual o mayor que cero.', true);
  if (hasDuplicateName(name)) return showNotice('Ya existe un producto con ese nombre.', true);
  if (hasDuplicateBarcode(barcode)) return showNotice('Ese código de barras ya está registrado.', true);
  try {
    await storeRequest('readwrite', store => store.add(withBarcodeKey({ name, barcode, quantity, createdAt: Date.now() })));
    await loadProducts();
    form.reset();
    quantityInput.value = '0';
    nameInput.focus();
    showNotice('Producto guardado correctamente.');
  } catch (error) { showSaveError(error); }
});

searchInput.addEventListener('input', render);

list.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const product = products.find(item => String(item.id) === button.dataset.id);
  if (!product) return;
  if (button.dataset.action === 'edit') {
    document.querySelector('#edit-id').value = product.id;
    document.querySelector('#edit-name').value = product.name;
    document.querySelector('#edit-barcode').value = product.barcode || '';
    document.querySelector('#edit-quantity').value = product.quantity;
    editDialog.showModal();
    document.querySelector('#edit-name').focus();
  } else if (button.dataset.action === 'stock') {
    document.querySelector('#stock-id').value = product.id;
    document.querySelector('#stock-product-name').textContent = product.name;
    document.querySelector('#stock-amount').value = '1';
    stockDialog.showModal();
    document.querySelector('#stock-amount').focus();
  } else if (button.dataset.action === 'delete') {
    if (!window.confirm(`¿Eliminar “${product.name}” del inventario? Esta acción no se puede deshacer.`)) return;
    try {
      await storeRequest('readwrite', store => store.delete(product.id));
      await loadProducts();
      showNotice('Producto eliminado.');
    } catch (error) { showSaveError(error); }
  }
});

document.querySelector('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = Number(document.querySelector('#edit-id').value);
  const name = cleanName(document.querySelector('#edit-name').value);
  const barcode = cleanBarcode(document.querySelector('#edit-barcode').value);
  const quantity = validInteger(document.querySelector('#edit-quantity').value);
  const product = products.find(item => item.id === id);
  if (!product) return showNotice('No encontramos ese producto.', true);
  if (!name) return showNotice('Escribe el nombre del producto.', true);
  if (quantity === null) return showNotice('La cantidad debe ser un número entero igual o mayor que cero.', true);
  if (hasDuplicateName(name, id)) return showNotice('Ya existe otro producto con ese nombre.', true);
  if (hasDuplicateBarcode(barcode, id)) return showNotice('Ese código de barras ya está asignado a otro producto.', true);
  try {
    await storeRequest('readwrite', store => store.put(withBarcodeKey({ ...product, name, barcode, quantity })));
    editDialog.close();
    await loadProducts();
    showNotice('Cambios guardados correctamente.');
  } catch (error) { showSaveError(error); }
});

document.querySelector('#stock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = Number(document.querySelector('#stock-id').value);
  const amount = validInteger(document.querySelector('#stock-amount').value, 1);
  const product = products.find(item => item.id === id);
  if (!product) return showNotice('No encontramos ese producto.', true);
  if (amount === null) return showNotice('Escribe un número entero mayor que cero.', true);
  if (!Number.isSafeInteger(product.quantity + amount)) return showNotice('La cantidad total supera el límite permitido.', true);
  try {
    await storeRequest('readwrite', store => store.put({ ...product, quantity: product.quantity + amount }));
    stockDialog.close();
    await loadProducts();
    showNotice(`Se sumaron ${amount} ${amount === 1 ? 'unidad' : 'unidades'}.`);
  } catch (error) { showSaveError(error); }
});

function stopScanner() {
  if (scanFrame) cancelAnimationFrame(scanFrame);
  scanFrame = undefined;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  scannerVideo.srcObject = null;
  scanBusy = false;
}

async function scanContinuously(detector) {
  if (!scannerDialog.open || !cameraStream) return;
  if (!scanBusy && scannerVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    scanBusy = true;
    try {
      const results = await detector.detect(scannerVideo);
      if (results.length && scannerDialog.open) {
        scannerTarget.value = results[0].rawValue;
        scannerTarget.dispatchEvent(new Event('input', { bubbles: true }));
        scannerStatus.textContent = `Código leído: ${results[0].rawValue}`;
        stopScanner();
        scannerDialog.close();
        scannerTarget.focus();
        showNotice('Código de barras leído. Revisa el código y guarda el producto.');
        return;
      }
    } catch {
      scannerStatus.textContent = 'No se pudo leer la imagen. Ajusta la luz o escribe el código manualmente.';
    } finally { scanBusy = false; }
  }
  if (scannerDialog.open) scanFrame = requestAnimationFrame(() => scanContinuously(detector));
}

async function openScanner(targetId) {
  scannerTarget = document.getElementById(targetId);
  scannerStatus.textContent = 'Solicitando acceso a la cámara…';
  scannerDialog.showModal();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    scannerStatus.textContent = 'La cámara requiere HTTPS (o localhost). Puedes escribir el código manualmente.';
    return;
  }
  if (!('BarcodeDetector' in window)) {
    scannerStatus.textContent = 'Este navegador no incluye lector de códigos. Puedes escribirlo manualmente o probar Chrome actualizado.';
    return;
  }
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'].filter(format => supported.includes(format));
    if (!formats.length) throw new Error('Este navegador no reconoce formatos de código de barras compatibles.');
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (!scannerDialog.open) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = undefined;
      return;
    }
    scannerVideo.srcObject = cameraStream;
    await scannerVideo.play();
    scannerStatus.textContent = 'Apunta la cámara al código. La lectura se realiza en este dispositivo.';
    scanContinuously(new BarcodeDetector({ formats }));
  } catch (error) {
    stopScanner();
    scannerStatus.textContent = error.name === 'NotAllowedError'
      ? 'No se concedió permiso para usar la cámara. Actívalo en el navegador o escribe el código manualmente.'
      : `${error.message || 'No se pudo iniciar la cámara.'} Puedes escribir el código manualmente.`;
  }
}

document.querySelectorAll('[data-scan-target]').forEach(button => button.addEventListener('click', () => openScanner(button.dataset.scanTarget)));
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
[editDialog, stockDialog].forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));
scannerDialog.addEventListener('click', event => {
  if (event.target === scannerDialog) scannerDialog.close();
});
scannerDialog.addEventListener('close', stopScanner);

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
  }
});

async function startApp() {
  try {
    db = await openDatabase();
    await loadProducts();
  } catch (error) {
    showNotice(`${error.message} Prueba en localhost con VS Code Live Server.`, true);
    form.querySelector('button[type="submit"]').disabled = true;
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => showNotice('No se pudo activar el modo sin conexión.', true));
  }
}

startApp();
