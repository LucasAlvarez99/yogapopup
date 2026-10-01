/* Yoga Pop Up · JS mínimo (solo interfaz, sin backend) */
document.addEventListener('DOMContentLoaded', () => {

  // 1) Aparición suave al hacer scroll
  const items = document.querySelectorAll('.reveal');
  // Si se llega con un ancla (p. ej. index.html#tienda, como enlazan el menú y el pie de las demás
  // páginas), el navegador salta directo a esa sección antes de que el scroll dispare la animación:
  // sin este atajo, las tarjetas que ya están a la vista quedan invisibles y no hay forma de revelarlas.
  if (location.hash) {
    items.forEach((el) => el.classList.add('is-visible'));
  } else if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    items.forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 80}ms`; io.observe(el); });
  } else {
    items.forEach((el) => el.classList.add('is-visible'));
  }

  // 2) Link activo del navbar según la sección visible
  const links = document.querySelectorAll('.navbar-nav .nav-link');
  // Índices de los enlaces del menú ("Videoteca" es otra página, por eso no está en el mapa)
  const map = { inicio: 0, productos: 0, cursos: 1, clases: 2, tienda: 4, nosotros: 5 };
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting && map[e.target.id] !== undefined) {
        links.forEach((l) => l.classList.remove('active'));
        links[map[e.target.id]].classList.add('active');
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  Object.keys(map).forEach((id) => { const s = document.getElementById(id); if (s) spy.observe(s); });

  // 3) Reemplaza los manejadores inline (onerror/onsubmit): permiten una CSP estricta sin scripts en línea
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-hide-on-error')) e.target.remove();
  }, true);
  document.querySelectorAll('.search-pill').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));

  // 4) Cierra el menú móvil al elegir una opción
  const menu = document.getElementById('mainMenu');
  links.forEach((l) => l.addEventListener('click', () => {
    if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
  }));
});
