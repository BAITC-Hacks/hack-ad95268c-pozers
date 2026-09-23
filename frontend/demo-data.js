/* Only fictional fixtures. No API, real prices, inventory or certificates. */
(() => {
  "use strict";
  window.EktDemo = window.EktDemo || {};
  window.EktDemo.products = Object.freeze([
    {
      id: "demo-breaker", name: "Автоматический выключатель C16", sku: "DEMO-AV-016",
      price: 2450, stock: 8, unit: "шт.", kind: "breaker",
      features: ["1 полюс · 16 А", "Характеристика C · 6 кА"], certificateUrl: null,
    },
    {
      id: "demo-cable", name: "Кабель ВВГнг-LS 3×2,5", sku: "DEMO-KB-325",
      price: 890, stock: 25, unit: "м", kind: "cable",
      features: ["Медь · 3 жилы × 2,5 мм²", "Низкое дымовыделение"], certificateUrl: null,
    },
    {
      id: "demo-socket", name: "Розетка с заземлением", sku: "DEMO-RZ-001",
      price: 1850, stock: 5, unit: "шт.", kind: "socket",
      features: ["16 А · 250 В · IP20", "Скрытый монтаж · белый"], certificateUrl: null,
    },
  ].map(product => Object.freeze({ ...product, features: Object.freeze(product.features) })));
})();
