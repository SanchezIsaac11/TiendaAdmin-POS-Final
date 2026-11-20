/**
 * ==============================================================================
 * MÓDULO DE IMPRESIÓN DE TICKETS TÉRMICOS (58mm / POS-58 / ESC-POS)
 * ==============================================================================
 * Archivo: www/js/app/printTicket.js
 * 
 * Centraliza la lógica de impresión de tickets tanto para ventas inmediatas
 * como para reimpresión de tickets desde el historial:
 * 1. Formateo de datos de tienda y venta
 * 2. Manejo de cajero asignado vs administrador
 * 3. Envío directo a impresora térmica en Electron vía IPC (window.electronAPI.printTicket)
 * 4. Fallback automático a iframe invisible / diálogo del navegador en entornos web/móvil
 * ==============================================================================
 */

(function (global) {
  function escapeTicketHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Obtiene el nombre del cajero para imprimir según su rol.
   * Si es administrador o gerente, devuelve null para omitir la línea del cajero.
   */
  function getCashierDisplay(cashier, role) {
    if (!cashier && !role) return null;
    const roleStr = String(role || '').trim().toLowerCase();
    if (roleStr === 'admin' || roleStr === 'administrador' || roleStr === 'gerente') return null;
    const nameStr = String(cashier || '').trim();
    if (!nameStr) return null;
    const lowerName = nameStr.toLowerCase();
    if (lowerName === 'admin' || lowerName === 'administrador' || lowerName === 'administrator' || lowerName === 'gerente') return null;
    return nameStr;
  }

  /**
   * Obtiene la configuración de tienda (nombre y dirección)
   */
  async function getStoreSettings() {
    let storeName = 'TIENDA ABARROTES';
    let storeAddress = '';

    try {
      if (global.PosDataService && typeof global.PosDataService.getStoreSettings === 'function') {
        const s = await global.PosDataService.getStoreSettings();
        if (s) {
          if (s.store_name) storeName = s.store_name;
          if (s.address && !String(s.address).includes('Insurgentes')) storeAddress = s.address;
        }
      } else if (typeof localStorage !== 'undefined') {
        const cached = JSON.parse(localStorage.getItem('pos_store_settings') || '{}');
        if (cached.store_name) storeName = cached.store_name;
        if (cached.address && !String(cached.address).includes('Insurgentes')) storeAddress = cached.address;
      }
    } catch (e) {
      console.warn('[printTicket] Error obteniendo store_settings:', e);
    }

    return { storeName, storeAddress };
  }

  /**
   * Imprime el ticket vía iframe invisible (entornos navegador / fallback)
   */
  function printViaIframe(ticketHTML, folio) {
    if (typeof document === 'undefined') return;

    const printFrame = document.createElement('iframe');
    printFrame.style.position = 'fixed';
    printFrame.style.right = '0';
    printFrame.style.bottom = '0';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    document.body.appendChild(printFrame);

    const doc = printFrame.contentWindow.document;
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Ticket ${folio || ''}</title>
        <style>
          @page { size: 58mm auto; margin: 0; }
          body {
            font-family: 'Courier New', Courier, monospace, monospace;
            width: 48mm;
            margin: 0 auto;
            padding: 4px 2px;
            color: #000;
            font-size: 11px;
            line-height: 1.25;
            zoom: 0.8;
          }
          .ticket-title { font-weight: bold; font-size: 13px; text-align: center; margin-bottom: 2px; }
          .ticket-subtitle { font-weight: bold; font-size: 12px; text-align: center; margin: 2px 0; }
          .ticket-address { font-size: 10px; text-align: center; margin-bottom: 3px; }
          .ticket-meta { font-size: 11px; text-align: center; }
          .ticket-divider { border-top: 1px dashed #000000; margin: 4px 0; }
          .ticket-total-large { font-size: 18px !important; font-weight: bold !important; margin: 6px 0; }
          .ticket-payment-row { font-size: 11px; display: flex; justify-content: space-between; margin: 2px 0; }
          .ticket-footer { text-align: center; font-weight: bold; font-size: 11px; margin-top: 6px; }
        </style>
      </head>
      <body>
        ${ticketHTML}
      </body>
      </html>
    `);
    doc.close();

    printFrame.contentWindow.focus();
    setTimeout(() => {
      try {
        printFrame.contentWindow.print();
      } catch (e) {
        console.warn('[printTicket] Error imprimiendo vía iframe, fallback window.print:', e);
        if (typeof global.print === 'function') global.print();
      } finally {
        setTimeout(() => {
          if (printFrame && printFrame.parentNode) {
            printFrame.parentNode.removeChild(printFrame);
          }
        }, 1000);
      }
    }, 250);
  }

  /**
   * Función principal para imprimir un ticket de venta
   * @param {Object} ticket - Datos de la venta a imprimir
   * @returns {Promise<Object>} Resultado del envío a la impresora
   */
  async function printTicket(ticket) {
    if (!ticket) {
      console.warn('[printTicket] Se intentó imprimir pero no se recibió ningún ticket válido.');
      return { ok: false, error: 'Ticket no especificado' };
    }

    try {
      const { storeName, storeAddress } = await getStoreSettings();

      // Formateo de fecha
      const dateStr = ticket.created_at
        ? new Date(ticket.created_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
        : (ticket.date || new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }));

      // Formateo de método de pago
      const methodNames = {
        cash: 'Efectivo',
        card: 'Tarjeta Bancaria',
        transfer: 'Transferencia',
        qr: 'Pago QR',
        codi: 'CoDi'
      };
      const rawMethod = ticket.paymentMethod || ticket.payment_method || 'cash';
      const payMethodName = methodNames[rawMethod] || rawMethod || 'Efectivo';

      // Caja y Cajero
      const rawCashier = ticket.cashier || ticket.cashierName || ticket.cashier_name || ticket.user || ticket.userName || ticket.user_name || ticket.cajero;
      const rawRole = ticket.role || ticket.userRole || ticket.user_role;
      const cashierToPrint = getCashierDisplay(rawCashier, rawRole);
      const cajaLabel = ticket.cajaName || ticket.cajaCode || ticket.caja || 'Caja 1';
      const folio = ticket.folio || 'S/F';

      // Estructuración de artículos
      let structuredItems = [];
      let itemsListHtml = '';

      if (Array.isArray(ticket.items) && ticket.items.length > 0) {
        structuredItems = ticket.items.map(item => {
          const qty = parseFloat(item.quantity || item.qty || 1) || 1;
          const isBulk = item.saleType === 'bulk' || item.sale_type === 'bulk' || (qty % 1 !== 0);
          const name = item.name || 'Artículo';
          const price = parseFloat(item.unitPrice || item.price || 0);
          const totalProd = (item.total != null) ? parseFloat(item.total) : (price * qty);
          return { quantity: qty, qtyText: isBulk ? `${qty}kg` : `${qty}x`, name, total: totalProd, price };
        });
        itemsListHtml = structuredItems.map(item => `
          <div class="ticket-item-row" style="display:flex; justify-content:space-between; margin:2px 0;">
            <span>${item.qtyText} ${escapeTicketHtml(item.name)}</span>
            <span>$${item.total.toFixed(2)}</span>
          </div>
        `).join('');
      } else if (ticket.itemsDetail) {
        const parts = String(ticket.itemsDetail).split(', ');
        structuredItems = parts.map(part => {
          const match = part.match(/(.+?)\s+x(\d+(?:\.\d+)?)$/i);
          if (match) {
            return { quantity: parseFloat(match[2]), name: match[1].trim(), total: 0 };
          }
          return { quantity: 1, name: part.trim(), total: 0 };
        });
        itemsListHtml = structuredItems.map(item => `
          <div class="ticket-item-row" style="display:flex; justify-content:space-between; margin:2px 0;">
            <span>${item.quantity}x ${escapeTicketHtml(item.name)}</span>
            <span>-</span>
          </div>
        `).join('');
      } else {
        const count = ticket.itemsCount || 1;
        const summary = ticket.itemsSummary || 'Venta general';
        const totalFallback = parseFloat(ticket.total || 0);
        structuredItems = [{ quantity: count, name: summary, total: totalFallback }];
        itemsListHtml = `
          <div class="ticket-item-row" style="display:flex; justify-content:space-between; margin:2px 0;">
            <span>${count}x ${escapeTicketHtml(summary)}</span>
            <span>$${totalFallback.toFixed(2)}</span>
          </div>
        `;
      }

      // Totales e importes
      const totalVal = parseFloat(ticket.total || 0);
      let recVal = (ticket.amountReceived != null)
        ? parseFloat(ticket.amountReceived)
        : ((ticket.cashReceived != null) ? parseFloat(ticket.cashReceived) : totalVal);

      let changeVal = (ticket.change != null)
        ? parseFloat(ticket.change)
        : ((ticket.cashChange != null) ? parseFloat(ticket.cashChange) : Math.max(0, recVal - totalVal));

      if (rawMethod !== 'cash') {
        recVal = totalVal;
        changeVal = 0;
      }

      // Construcción del HTML para vista térmica
      const cleanAddress = (storeAddress || '').trim();
      const ticketHTML = `
        <div class="ticket-title">${escapeTicketHtml(storeName)}</div>${cleanAddress ? `\n        <div class="ticket-address">${escapeTicketHtml(cleanAddress)}</div>` : ''}
        <div class="ticket-subtitle">Ticket de Venta</div>
        <div class="ticket-meta">Fecha: ${escapeTicketHtml(dateStr)}</div>
        <div class="ticket-meta">Caja: ${escapeTicketHtml(cajaLabel)}</div>${cashierToPrint ? `\n        <div class="ticket-meta">Cajero: ${escapeTicketHtml(cashierToPrint)}</div>` : ''}
        <div class="ticket-divider"></div>
        <div class="ticket-items-table">
          ${itemsListHtml}
        </div>
        <div class="ticket-divider"></div>
        <div class="ticket-total-large" style="font-size:18px; font-weight:bold; margin:6px 0;">
          <div style="display:flex; justify-content:space-between;">
            <span>TOTAL:</span>
            <span>$${totalVal.toFixed(2)}</span>
          </div>
        </div>
        <div class="ticket-payment-row" style="display:flex; justify-content:space-between; margin:2px 0;">
          <span>Efectivo recibido:</span>
          <span>$${recVal.toFixed(2)}</span>
        </div>
        <div class="ticket-payment-row" style="display:flex; justify-content:space-between; margin:2px 0;">
          <span>Cambio:</span>
          <span>$${changeVal.toFixed(2)}</span>
        </div>
        <div class="ticket-payment-row" style="display:flex; justify-content:space-between; margin:2px 0;">
          <span>Forma de pago:</span>
          <span>${escapeTicketHtml(payMethodName)}</span>
        </div>
        <div class="ticket-divider"></div>
        <div class="ticket-footer" style="text-align:center; font-weight:bold; margin-top:6px;">
          ¡Gracias por su compra!
        </div>
      `;

      // Payload preparado para impresión ESC/POS directa en Electron
      const ticketPayload = {
        storeName,
        storeAddress,
        folio,
        date: dateStr,
        caja: cajaLabel,
        cashier: cashierToPrint || undefined,
        role: rawRole || undefined,
        items: structuredItems,
        total: totalVal,
        amountReceived: recVal,
        change: changeVal,
        paymentMethod: payMethodName,
        html: ticketHTML
      };

      // 1. Envío directo y silencioso en Electron si está disponible
      if (global.electronAPI && typeof global.electronAPI.printTicket === 'function') {
        try {
          const result = await global.electronAPI.printTicket(ticketPayload);
          console.log('[printTicket] Ticket enviado exitosamente a la impresora térmica:', result);
          return { ok: true, method: 'electron', result };
        } catch (err) {
          console.error('[printTicket] Error en electronAPI.printTicket, usando iframe fallback:', err);
          printViaIframe(ticketHTML, folio);
          return { ok: true, method: 'iframe_fallback', error: err.message };
        }
      }

      // 2. Si se ejecuta desde navegador local, intentar impresión directa vía servidor Node.js (sin diálogo)
      if (typeof fetch === 'function') {
        try {
          const basePath = (global.BACKEND_API_URL)
            ? global.BACKEND_API_URL
            : ((typeof window !== 'undefined' && (window.location.protocol === 'file:' || (window.location.port !== '3000' && window.location.hostname === 'localhost'))) ? 'http://localhost:3000' : '');
          const resp = await fetch(`${basePath}/api/pos/print-ticket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ticketPayload)
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data && data.ok) {
              console.log('[printTicket] Ticket impreso directamente vía backend local:', data);
              return { ok: true, method: 'backend_direct', result: data };
            }
          }
        } catch (backendPrintErr) {
          console.warn('[printTicket] Impresión directa vía backend no disponible, usando iframe fallback:', backendPrintErr.message);
        }
      }

      // 3. Fallback a iframe (escala 80% aplicada en CSS)
      printViaIframe(ticketHTML, folio);
      return { ok: true, method: 'iframe' };
    } catch (error) {
      console.error('[printTicket] Error procesando ticket para impresión:', error);
      return { ok: false, error: error.message };
    }
  }

  // Exportar globalmente
  global.printTicket = printTicket;
  global.printTicketDirectly = printTicket; // Alias de compatibilidad
  global.getCashierDisplayName = getCashierDisplay;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      printTicket,
      getCashierDisplayName: getCashierDisplay
    };
  }
})(typeof window !== 'undefined' ? window : global);
