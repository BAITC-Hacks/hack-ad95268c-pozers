/* Integration boundary: replace getReply with your server adapter later.
 * Input: message (string). Output: Promise<{ text: string, productIds: string[] }>.
 * The view never makes requests. These deterministic replies are demo fixtures.
 */
(() => {
  "use strict";
  const demo = window.EktDemo;
  demo.getReply = async function getReply(message) {
    const query = message.toLocaleLowerCase("ru").trim();
    if (!query) throw new Error("Введите сообщение.");
    if (/сертификат|документ/.test(query)) {
      return { text: "В тестовых данных нет ссылок на сертификаты. Когда в данных появится ссылка, она будет показана в карточке товара.", productIds: [] };
    }
    const matches = demo.products.filter(product =>
      query.includes(product.sku.toLowerCase()) ||
      (product.kind === "cable" && /кабел|провод|ввг/.test(query)) ||
      (product.kind === "breaker" && /автомат|выключател/.test(query)) ||
      (product.kind === "socket" && /розет/.test(query))
    );
    if (matches.length) {
      return { text: "Вот совпадения из тестового каталога. Цены и остатки вымышлены. Выберите товар, затем проверьте количество перед добавлением в демо-корзину.", productIds: matches.map(product => product.id) };
    }
    return {
      text: /все|каталог|товар/.test(query)
        ? "В демо-каталоге три тестовых товара. Можно посмотреть характеристики и попробовать добавить их в корзину."
        : "Это заранее заданный тестовый ответ: ИИ пока не подключён. Я могу показать кабель, автоматический выключатель или розетку. Вот доступные примеры:",
      productIds: demo.products.map(product => product.id),
    };
  };
})();
