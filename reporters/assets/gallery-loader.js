(() => {
  if (location.protocol === 'file:') return;
  const module = document.createElement('script');
  module.type = 'module';
  module.src = 'assets/gallery-archive.js';
  document.head.append(module);
})();
