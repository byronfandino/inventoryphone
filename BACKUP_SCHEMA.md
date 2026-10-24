# Esquema de copia JSON

La copia canónica usa UTF-8 y el formato actual versión 2:

```json
{
  "format": "inventario-local",
  "version": 2,
  "app": "Inventario local",
  "exportedAt": "2026-10-24T15:00:00.000Z",
  "products": [
    {
      "barcode": "0001234567890",
      "name": "Café molido",
      "quantity": 4,
      "previousPurchaseQuantity": null
    }
  ]
}
```

Cada producto de versión 2 debe tener exactamente esos cuatro campos. `barcode` y `name` son texto; el código vacío se conserva para productos antiguos sin código. `quantity` es un entero seguro no negativo. `previousPurchaseQuantity` es `null` cuando está vacío o un entero seguro no negativo. No se exportan IDs internos ni índices de IndexedDB. Los nombres duplicados (ignorando mayúsculas, minúsculas y espacios repetidos) y códigos duplicados (ignorando espacios externos y mayúsculas) no se aceptan. Los códigos son texto para preservar ceros iniciales.

El importador también acepta copias versión 1 creadas por la versión anterior de la app. Ignora sus campos internos `id`, `nameKey`, `barcodeKey` y `createdAt`, y convierte un campo opcional ausente a `null`; los IDs antiguos nunca se reutilizan. Las versiones posteriores no reconocidas se rechazan.

## Plan de verificación

1. Exportar una copia con nombres con tildes y `ñ`, códigos con ceros iniciales, campo opcional vacío y campo opcional diligenciado; importar en modo reemplazo y comprobar todos los valores.
2. Importar la misma copia en una base limpia; confirmar cantidad previa vacía (`null`) y códigos idénticos.
3. Probar JSON malformado, formato o versión no admitidos, propiedades/campos faltantes, tipos incorrectos, cantidades negativas/decimales y duplicados internos. Cada caso debe mostrar errores y no guardar nada.
4. En modo agregar, probar coincidencias de nombre/código con registros existentes y verificar que se reportan y no se agrega ningún producto.
5. En modo reemplazo, cancelar confirmación y verificar que los datos actuales siguen intactos.
6. Provocar una falla de escritura dentro de una transacción de reemplazo (por ejemplo, una restricción única inesperada) y comprobar que IndexedDB revierte también el `clear`, sin inventario parcial.
7. Exportar CSV y verificar BOM UTF-8, encabezados consistentes, comillas escapadas y los cuatro campos.

La prevalidación de duplicados evita los errores normales antes de abrir la transacción. IndexedDB aplica `clear` y todas las altas dentro de una sola transacción `readwrite`; un error aborta la transacción y revierte el vaciado y las altas.
