/**
 * SUBMÓDULO POS: MANEJO DE SERVICIOS Y RECARGAS (posServices.js)
 * Venta de tiempo aire (Telcel/Movistar), pago de servicios (CFE, agua, gas) y comisiones
 */

function initPosServices() {
  const btnToggleServices = document.getElementById('btnToggleServices');
  const servicesListContainer = document.getElementById('servicesListContainer');
  const servicesToggleArrow = document.getElementById('servicesToggleArrow');

  if (btnToggleServices && servicesListContainer) {
    btnToggleServices.addEventListener('click', (e) => {
      e.preventDefault();
      const computedDisplay = window.getComputedStyle ? window.getComputedStyle(servicesListContainer).display : servicesListContainer.style.display;
      const isHidden = computedDisplay === 'none';
      if (isHidden) {
        servicesListContainer.style.display = 'flex';
        servicesListContainer.classList.add('open');
        btnToggleServices.classList.add('active');
        btnToggleServices.setAttribute('aria-expanded', 'true');
        if (servicesToggleArrow) servicesToggleArrow.classList.add('open');
        if (typeof servicesListContainer.scrollIntoView === 'function') {
          setTimeout(() => servicesListContainer.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
        }
      } else {
        servicesListContainer.style.display = 'none';
        servicesListContainer.classList.remove('open');
        btnToggleServices.classList.remove('active');
        btnToggleServices.setAttribute('aria-expanded', 'false');
        if (servicesToggleArrow) servicesToggleArrow.classList.remove('open');
      }
    });
  }

  const serviceCards = document.querySelectorAll('.service-card');
  serviceCards.forEach(card => {
    card.addEventListener('click', () => {
      const serviceName = card.dataset.service;
      openQuickServiceModal(serviceName);
    });
  });

  // =========================================================================
  // SISTEMA DE SERVICIOS Y RECARGAS RÁPIDAS
  // =========================================================================
  let currentSelectedService = null;
  const modalQuickService = document.getElementById('modalQuickService');
  const quickServiceTitle = document.getElementById('quickServiceTitle');
  const quickServiceFieldLabel = document.getElementById('quickServiceFieldLabel');
  const quickServiceInputRef = document.getElementById('quickServiceInputRef');
  const quickServiceInputAmount = document.getElementById('quickServiceInputAmount');
  const btnConfirmQuickService = document.getElementById('btnConfirmQuickService');
  const btnCancelQuickService = document.getElementById('btnCancelQuickService');
  const btnCloseQuickService = document.getElementById('btnCloseQuickService');

  function openQuickServiceModal(serviceName) {
    currentSelectedService = serviceName;
    if (!modalQuickService) return;

    if (serviceName.includes('Recargas')) {
      quickServiceTitle.textContent = 'Recarga de Tiempo Aire';
      quickServiceFieldLabel.textContent = 'Número de Celular (10 dígitos):';
      quickServiceInputRef.placeholder = 'Ej. 55 1234 5678';
      quickServiceInputAmount.value = '50.00';
    } else if (serviceName.includes('5.00')) {
      quickServiceTitle.textContent = 'Pago de Servicio (+ Comisión $5.00)';
      quickServiceFieldLabel.textContent = 'Referencia o Código del Recibo:';
      quickServiceInputRef.placeholder = 'Número de recibo CFE, Telmex, etc.';
      quickServiceInputAmount.value = '100.00';
    } else if (serviceName.includes('Pago de servicios')) {
      quickServiceTitle.textContent = 'Pago de Servicios (Luz, Agua, Gas)';
      quickServiceFieldLabel.textContent = 'Referencia del Recibo:';
      quickServiceInputRef.placeholder = 'Referencia de 30 dígitos';
      quickServiceInputAmount.value = '250.00';
    } else {
      quickServiceTitle.textContent = 'Otros Trámites y Servicios';
      quickServiceFieldLabel.textContent = 'Concepto o Referencia:';
      quickServiceInputRef.placeholder = 'Descripción';
      quickServiceInputAmount.value = '20.00';
    }

    modalQuickService.style.display = 'flex';
    quickServiceInputRef.focus();
  }

  if (btnConfirmQuickService) {
    btnConfirmQuickService.addEventListener('click', () => {
      const ref = (quickServiceInputRef.value || '').trim();
      let amount = parseFloat(quickServiceInputAmount.value) || 0;
      if (amount <= 0) {
        alert('Ingresa un monto válido mayor a 0');
        return;
      }

      if (currentSelectedService && currentSelectedService.includes('5.00')) {
        amount += 5.00;
      }

      const serviceItem = {
        id: Date.now(),
        sku: 'SRV-' + Math.floor(1000 + Math.random() * 9000),
        name: `${currentSelectedService}${ref ? ' (' + ref + ')' : ''}`,
        displayName: `${currentSelectedService}${ref ? ' (' + ref + ')' : ''}`,
        unitPrice: amount,
        quantity: 1,
        iconType: 'tag',
        category: 'Servicios',
        isService: true
      };

      state.cart.push(serviceItem);
      renderCart();
      modalQuickService.style.display = 'none';
      quickServiceInputRef.value = '';
      showModal('Servicio Agregado', `${serviceItem.name} por ${amount.toFixed(2)} fue agregado al ticket de venta.`);
    });
  }

  if (btnCancelQuickService) btnCancelQuickService.addEventListener('click', () => modalQuickService.style.display = 'none');
  if (btnCloseQuickService) btnCloseQuickService.addEventListener('click', () => modalQuickService.style.display = 'none');


  // Exponer funciones en window
  window.openQuickServiceModal = openQuickServiceModal;
}

window.initPosServices = initPosServices;
