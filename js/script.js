/* Yoga Pop Up · JS mínimo (solo interfaz, sin backend) */
document.addEventListener('DOMContentLoaded', () => {

  // 1) Aparición suave al hacer scroll
  const items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    items.forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 80}ms`; io.observe(el); });
  } else {
    items.forEach((el) => el.classList.add('is-visible'));
  }

  // 2) Carrito visual: cantidades, quitar y subtotal (datos de ejemplo)
  const list = document.getElementById('cartList');
  const fmt = (n) => '$ ' + n.toLocaleString('es-AR');

  function refresh() {
    let total = 0, count = 0;
    list.querySelectorAll('.cart-item').forEach((li) => {
      const q = parseInt(li.querySelector('.qty span').textContent, 10);
      const price = parseInt(li.dataset.price, 10);
      li.querySelector('.cart-info strong').textContent = fmt(price * q);
      total += price * q; count += q;
    });
    document.getElementById('cartSubtotal').textContent = fmt(total);
    document.getElementById('cartCount').textContent = count;
    document.getElementById('cartTitleCount').textContent = count;
  }

  list.addEventListener('click', (e) => {
    const qtyBtn = e.target.closest('[data-qty]');
    const rm = e.target.closest('.cart-remove');
    if (qtyBtn) {
      const span = qtyBtn.closest('.qty').querySelector('span');
      span.textContent = Math.max(1, parseInt(span.textContent, 10) + parseInt(qtyBtn.dataset.qty, 10));
    }
    if (rm) rm.closest('.cart-item').remove();
    refresh();
  });

  // 3) Link activo del navbar según la sección visible
  const links = document.querySelectorAll('.navbar-nav .nav-link');
  const map = { inicio: 0, productos: 0, cursos: 1, clases: 2, tienda: 3, nosotros: 4 };
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting && map[e.target.id] !== undefined) {
        links.forEach((l) => l.classList.remove('active'));
        links[map[e.target.id]].classList.add('active');
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  Object.keys(map).forEach((id) => { const s = document.getElementById(id); if (s) spy.observe(s); });

  // 4) Cierra el menú móvil al elegir una opción
  const menu = document.getElementById('mainMenu');
  links.forEach((l) => l.addEventListener('click', () => {
    if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
  }));
});
