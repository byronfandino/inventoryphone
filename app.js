// Administra productos, códigos de barras y existencias en IndexedDB.
const DB_NAME = 'inventario-local-db';
const DB_VERSION = 3;
const STORE_NAME = 'productos';
const form = document.querySelector('#product-form');
const nameInput = document.querySelector('#product-name');
const barcodeInput = document.querySelector('#product-barcode');
const quantityInput = document.querySelector('#product-quantity');
const previousPurchaseInput = document.querySelector('#product-previous-purchase');
const voiceButton = document.querySelector('#voice-button');
const voiceStatus = document.querySelector('#voice-status');
const barcodeVoiceButton = document.querySelector('#barcode-voice-button');
const barcodeVoiceStatus = document.querySelector('#barcode-voice-status');
const searchVoiceButton = document.querySelector('#search-voice-button');
const searchVoiceStatus = document.querySelector('#search-voice-status');
const searchInput = document.querySelector('#search-input');
const list = document.querySelector('#product-list');
const emptyState = document.querySelector('#empty-state');
const emptyTitle = document.querySelector('#empty-title');
const emptyDescription = document.querySelector('#empty-description');
const notice = document.querySelector('#notice');
const editDialog = document.querySelector('#edit-dialog');
const stockDialog = document.querySelector('#stock-dialog');
const scannerDialog = document.querySelector('#scanner-dialog');
const importDialog = document.querySelector('#import-dialog');
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
let speechTarget;
let pendingImport;

const BACKUP_FORMAT = 'inventario-local';
const BACKUP_VERSION = 2;

const speechTargets = {
  name: { input: nameInput, button: voiceButton, status: voiceStatus, label: 'nombre del producto' },
  barcode: { input: barcodeInput, button: barcodeVoiceButton, status: barcodeVoiceStatus, label: 'código' },
  search: { input: searchInput, button: searchVoiceButton, status: searchVoiceStatus, label: 'búsqueda' }
};

function setVoiceStatus(target, message, isError = false) {
  target.status.textContent = message;
  target.status.classList.toggle('error-text', isError);
  target.status.hidden = !message;
}

function setVoiceButtonState(target, active) {
  target.button.setAttribute('aria-pressed', String(active));
  target.button.setAttribute('aria-label', active ? `Detener dictado de ${target.label}` : `Dictar ${target.label}`);
  const label = target.button.querySelector('span:not([aria-hidden="true"])');
  if (label) label.textContent = active ? 'Detener' : 'Dictar';
}

function stopVoiceRecognition(cancel = false) {
  if (!speechRecognition) return;
  speechCancelled = cancel;
  if (cancel) speechRecognition.abort();
  else speechRecognition.stop();
  if (speechTarget) setVoiceStatus(speechTarget, cancel ? 'Dictado cancelado.' : 'Finalizando el dictado…');
}

function startVoiceRecognition(target) {
  if (speechRecognition) {
    setVoiceStatus(target, 'Ya hay otro dictado activo. Espera a que termine e inténtalo de nuevo.', true);
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setVoiceStatus(target, 'Este navegador no admite dictado por voz. Puedes escribir el texto manualmente.', true);
    return;
  }
  if (!window.isSecureContext) {
    setVoiceStatus(target, 'El dictado requiere HTTPS o localhost. Puedes escribir el texto manualmente.', true);
    return;
  }
  speechRecognition = new Recognition();
  speechTarget = target;
  speechRecognition.lang = 'es-CO';
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechCancelled = false;
  speechRecognition.onstart = () => {
    speechActive = true;
    setVoiceButtonState(target, true);
    setVoiceStatus(target, 'Escuchando… Habla ahora.');
  };
  speechRecognition.onresult = event => {
    if (speechCancelled) return;
    const transcript = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript).join(' ').trim();
    if (transcript) {
      target.input.value = target === speechTargets.name ? cleanName(transcript) : transcript.trim();
      target.input.dispatchEvent(new Event('input', { bubbles: true }));
      setVoiceStatus(target, target === speechTargets.barcode
        ? `Código reconocido: ${target.input.value}. Revisa los dígitos, especialmente los ceros iniciales.`
        : `${target.label === 'búsqueda' ? 'Búsqueda' : 'Nombre'} reconocido: ${target.input.value}`);
    } else setVoiceStatus(target, 'No se reconoció texto. Inténtalo de nuevo.', true);
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
    setVoiceStatus(target, messages[event.error] || 'Ocurrió un error al reconocer la voz. Puedes escribir el texto manualmente.', true);
  };
  speechRecognition.onend = () => {
    speechActive = false;
    setVoiceButtonState(target, false);
    speechRecognition = undefined;
    speechTarget = undefined;
  };
  setVoiceStatus(target, 'Solicitando acceso al micrófono…');
  try { speechRecognition.start(); }
  catch {
    speechRecognition = undefined;
    speechTarget = undefined;
    setVoiceStatus(target, 'No se pudo iniciar el dictado. Espera un momento e inténtalo de nuevo.', true);
  }
}

Object.values(speechTargets).forEach(target => target.button.addEventListener('click', () => {
  if (speechTarget === target && speechActive) stopVoiceRecognition();
  else startVoiceRecognition(target);
}));

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && speechRecognition) stopVoiceRecognition(true);
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
        const record = { ...cursor.value, nameKey: normalizeText(cursor.value.name) };
        if (record.previousPurchaseQuantity === undefined) record.previousPurchaseQuantity = null;
        cursor.update(record);
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

function downloadFile(content, type, extension) {
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `inventario-${date}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

document.querySelector('#export-csv').addEventListener('click', () => {
  const rows = [
    ['Código de barras', 'Nombre', 'Cantidad restante', 'Cantidad comprada anteriormente'],
    ...products.map(product => [product.barcode || '', product.name, product.quantity, product.previousPurchaseQuantity ?? ''])
  ];
  const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
  downloadFile(csv, 'text/csv;charset=utf-8', 'csv');
  showNotice('Inventario exportado en CSV.');
});

document.querySelector('#export-json').addEventListener('click', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: 'Inventario local',
    exportedAt: new Date().toISOString(),
    products: products.map(product => ({
      barcode: product.barcode || '',
      name: product.name,
      quantity: product.quantity,
      previousPurchaseQuantity: product.previousPurchaseQuantity ?? null
    }))
  };
  downloadFile(`\uFEFF${JSON.stringify(backup, null, 2)}`, 'application/json;charset=utf-8', 'json');
  showNotice('Copia completa exportada en JSON.');
});

function validateBackup(backup) {
  const errors = [];
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return { errors: ['El archivo debe contener un objeto JSON de copia de seguridad.'] };
  if (backup.format !== BACKUP_FORMAT) errors.push(`Formato no reconocido. Se esperaba "${BACKUP_FORMAT}".`);
  if (![1, BACKUP_VERSION].includes(backup.version)) errors.push(`Versión no compatible. Esta app admite las versiones 1 y ${BACKUP_VERSION}.`);
  const legacyBackup = backup.version === 1;
  const allowedTopLevel = legacyBackup ? ['format', 'version', 'exportedAt', 'products'] : ['format', 'version', 'app', 'exportedAt', 'products'];
  const unknownTopLevel = Object.keys(backup).filter(key => !allowedTopLevel.includes(key));
  if (unknownTopLevel.length) errors.push(`La copia contiene campos no permitidos: ${unknownTopLevel.join(', ')}.`);
  if (!legacyBackup && backup.app !== 'Inventario local') errors.push('El campo "app" no identifica una copia de Inventario local.');
  if (typeof backup.exportedAt !== 'string' || Number.isNaN(Date.parse(backup.exportedAt))) errors.push('El campo "exportedAt" debe contener una fecha ISO válida.');
  if (!Array.isArray(backup.products)) errors.push('El campo "products" debe ser una lista de productos.');
  if (errors.length) return { errors };
  const names = new Set();
  const barcodes = new Set();
  const normalized = [];
  backup.products.forEach((product, index) => {
    const label = `Producto ${index + 1}`;
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      errors.push(`${label}: debe ser un objeto.`);
      return;
    }
    const expected = legacyBackup ? ['barcode', 'name', 'quantity'] : ['barcode', 'name', 'quantity', 'previousPurchaseQuantity'];
    const legacyFields = ['id', 'nameKey', 'barcodeKey', 'createdAt'];
    const unknown = Object.keys(product).filter(key => !expected.includes(key) && !(legacyBackup && legacyFields.includes(key)) && !(legacyBackup && key === 'previousPurchaseQuantity'));
    const missing = expected.filter(key => !Object.prototype.hasOwnProperty.call(product, key));
    if (unknown.length) errors.push(`${label}: campos no permitidos: ${unknown.join(', ')}.`);
    if (missing.length) errors.push(`${label}: faltan campos: ${missing.join(', ')}.`);
    if (typeof product.barcode !== 'string') errors.push(`${label}: "barcode" debe ser texto.`);
    if (typeof product.name !== 'string' || !cleanName(product.name)) errors.push(`${label}: "name" debe ser texto y no puede estar vacío.`);
    if (!Number.isSafeInteger(product.quantity) || product.quantity < 0) errors.push(`${label}: "quantity" debe ser un entero no negativo.`);
    const previousPurchaseQuantity = product.previousPurchaseQuantity === undefined && legacyBackup ? null : product.previousPurchaseQuantity;
    if (previousPurchaseQuantity !== null && (!Number.isSafeInteger(previousPurchaseQuantity) || previousPurchaseQuantity < 0)) errors.push(`${label}: "previousPurchaseQuantity" debe ser null o un entero no negativo.`);
    if (typeof product.barcode !== 'string' || typeof product.name !== 'string' || !cleanName(product.name) || !Number.isSafeInteger(product.quantity) || product.quantity < 0 || (previousPurchaseQuantity !== null && (!Number.isSafeInteger(previousPurchaseQuantity) || previousPurchaseQuantity < 0))) return;
    const name = cleanName(product.name);
    const nameKey = normalizeText(name);
    const barcode = cleanBarcode(product.barcode);
    const codeKey = barcodeKey(barcode);
    if (names.has(nameKey)) errors.push(`${label}: el nombre "${name}" está duplicado en la copia (no se permiten nombres repetidos ignorando mayúsculas/minúsculas y espacios).`);
    else names.add(nameKey);
    if (codeKey && barcodes.has(codeKey)) errors.push(`${label}: el código "${barcode}" está duplicado en la copia (se ignoran espacios externos y mayúsculas/minúsculas).`);
    else if (codeKey) barcodes.add(codeKey);
    normalized.push({ barcode, name, quantity: product.quantity, previousPurchaseQuantity });
  });
  return { errors, products: normalized };
}

function getImportConflicts(incoming, existing) {
  const conflicts = [];
  const names = new Map(existing.map(product => [normalizeText(product.name), product.name]));
  const barcodes = new Map(existing.filter(product => product.barcode).map(product => [barcodeKey(product.barcode), product.barcode]));
  incoming.forEach(product => {
    if (names.has(normalizeText(product.name))) conflicts.push(`Nombre repetido: "${product.name}" ya existe en el inventario.`);
    const key = barcodeKey(product.barcode);
    if (key && barcodes.has(key)) conflicts.push(`Código repetido: "${product.barcode}" ya existe en el inventario.`);
  });
  return conflicts;
}

document.querySelector('#import-json').addEventListener('click', () => document.querySelector('#import-file').click());
document.querySelector('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let validation;
  try { validation = validateBackup(JSON.parse(await file.text().then(text => text.replace(/^\uFEFF/, '')))); }
  catch { validation = { errors: ['No se pudo leer el archivo: verifica que sea JSON válido codificado en UTF-8.'] }; }
  pendingImport = validation.errors.length ? null : validation.products;
  const summary = document.querySelector('#import-summary');
  const errorsBox = document.querySelector('#import-errors');
  const applyButton = document.querySelector('#apply-import');
  summary.textContent = pendingImport ? `Copia válida: ${pendingImport.length} ${pendingImport.length === 1 ? 'producto' : 'productos'}. Elige el modo de importación.` : 'La copia no es válida y no se importará ningún registro.';
  errorsBox.hidden = !validation.errors.length;
  errorsBox.replaceChildren(...validation.errors.map(message => { const line = document.createElement('div'); line.textContent = message; return line; }));
  applyButton.disabled = !pendingImport;
  document.querySelector('input[name="import-mode"][value="replace"]').checked = true;
  document.querySelector('#import-mode-help').textContent = 'Reemplaza todos los productos actuales. Se pedirá confirmación antes de guardar.';
  importDialog.showModal();
});

document.querySelectorAll('input[name="import-mode"]').forEach(input => input.addEventListener('change', () => {
  document.querySelector('#import-mode-help').textContent = input.value === 'replace'
    ? 'Reemplaza todos los productos actuales. Se pedirá confirmación antes de guardar.'
    : 'Agrega los productos si no hay nombres o códigos repetidos. Ante cualquier conflicto no se agregará ninguno.';
}));

function commitImport(mode, incoming) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('La transacción se canceló; no se aplicaron cambios.'));
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo completar la importación.'));
    if (mode === 'replace') store.clear();
    incoming.forEach(product => store.add(withBarcodeKey({ ...product, createdAt: Date.now() })));
  });
}

document.querySelector('#apply-import').addEventListener('click', async () => {
  if (!pendingImport) return;
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  if (mode === 'replace' && !window.confirm(`Se reemplazará el inventario completo (${products.length} productos actuales) por ${pendingImport.length} productos de la copia. ¿Continuar?`)) return;
  const conflicts = mode === 'add' ? getImportConflicts(pendingImport, products) : [];
  if (conflicts.length) {
    const errorsBox = document.querySelector('#import-errors');
    errorsBox.replaceChildren(...conflicts.map(message => { const line = document.createElement('div'); line.textContent = message; return line; }));
    errorsBox.hidden = false;
    document.querySelector('#import-summary').textContent = `Se encontraron ${conflicts.length} conflictos. No se guardó ningún producto.`;
    return;
  }
  try {
    await commitImport(mode, pendingImport);
    importDialog.close();
    pendingImport = undefined;
    await loadProducts();
    showNotice(mode === 'replace' ? 'Inventario reemplazado correctamente.' : 'Productos agregados correctamente.');
  } catch (error) {
    showNotice(`La importación falló y no se aplicaron cambios: ${error.message}`, true);
  }
});

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
  const details = document.createElement('span');
  details.className = 'product-details';
  const name = document.createElement('span');
  name.className = 'product-name';
  name.textContent = product.name;
  const barcode = document.createElement('span');
  barcode.className = `product-barcode${product.barcode ? '' : ' missing-barcode'}`;
  barcode.textContent = product.barcode || 'Sin código';
  details.append(name, barcode);
  productCell.append(details);
  nameCell.append(productCell);
  const quantityCell = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = `quantity-pill${product.quantity <= 3 ? ' low' : ''}`;
  pill.textContent = product.quantity.toLocaleString('es');
  pill.setAttribute('aria-label', `${product.quantity} unidades`);
  quantityCell.append(pill);
  const previousCell = document.createElement('td');
  previousCell.textContent = product.previousPurchaseQuantity == null ? '—' : product.previousPurchaseQuantity.toLocaleString('es');
  const actionsCell = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.append(
    createAction('+ Sumar', 'stock', 'add-action', product.id, `Sumar existencias de ${product.name}`),
    createAction('Editar', 'edit', '', product.id, `Editar ${product.name}`),
    createAction('Eliminar', 'delete', 'delete-action', product.id, `Eliminar ${product.name}`)
  );
  actionsCell.append(actions);
  row.append(nameCell, quantityCell, previousCell, actionsCell);
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
  const previousPurchaseQuantity = validInteger(previousPurchaseInput.value);
  if (!name) return showNotice('Escribe el nombre del producto.', true);
  if (!barcode) return showNotice('Escribe o escanea el código de barras del producto.', true);
  if (quantity === null) return showNotice('La cantidad debe ser un número entero igual o mayor que cero.', true);
  if (previousPurchaseInput.value !== '' && previousPurchaseQuantity === null) return showNotice('La cantidad comprada anteriormente debe ser un número entero igual o mayor que cero, o quedar vacía.', true);
  if (hasDuplicateName(name)) return showNotice('Ya existe un producto con ese nombre.', true);
  if (hasDuplicateBarcode(barcode)) return showNotice('Ese código de barras ya está registrado.', true);
  try {
    await storeRequest('readwrite', store => store.add(withBarcodeKey({ name, barcode, quantity, previousPurchaseQuantity, createdAt: Date.now() })));
    await loadProducts();
    form.reset();
    quantityInput.value = '0';
    previousPurchaseInput.value = '';
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
    document.querySelector('#edit-previous-purchase').value = product.previousPurchaseQuantity ?? '';
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
  const previousInput = document.querySelector('#edit-previous-purchase');
  const previousPurchaseQuantity = validInteger(previousInput.value);
  const product = products.find(item => item.id === id);
  if (!product) return showNotice('No encontramos ese producto.', true);
  if (!name) return showNotice('Escribe el nombre del producto.', true);
  if (quantity === null) return showNotice('La cantidad debe ser un número entero igual o mayor que cero.', true);
  if (previousInput.value !== '' && previousPurchaseQuantity === null) return showNotice('La cantidad comprada anteriormente debe ser un número entero igual o mayor que cero, o quedar vacía.', true);
  if (hasDuplicateName(name, id)) return showNotice('Ya existe otro producto con ese nombre.', true);
  if (hasDuplicateBarcode(barcode, id)) return showNotice('Ese código de barras ya está asignado a otro producto.', true);
  try {
    await storeRequest('readwrite', store => store.put(withBarcodeKey({ ...product, name, barcode, quantity, previousPurchaseQuantity })));
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
