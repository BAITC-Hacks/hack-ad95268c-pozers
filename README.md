# hack-ad95268c-pozers
Hackathon team repository for Pozers

## Backend

Минимальный сервер на Node.js и Express. Нужен Node.js 22 или новее.

Установите зависимости:

```sh
npm install
```

Скопируйте `.env.example` в `.env`. В PowerShell:

```powershell
Copy-Item .env.example .env
```

Переменная `PORT` задаёт порт сервера (по умолчанию `3000`). Настоящие ключи
в примере отсутствуют, а `.env` исключён из Git.

Запустите сервер:

```sh
npm start
```

Или запустите режим разработки с автоматическим перезапуском при изменении кода:

```sh
npm run dev
```

Используйте один режим запуска за раз. Для остановки нажмите `Ctrl+C`.

Откройте http://localhost:3000/api/health — сервер вернёт:

```json
{ "ok": true }
```

Если PowerShell блокирует `npm.ps1`, используйте `npm.cmd install`,
`npm.cmd start` и `npm.cmd run dev` вместо соответствующих команд `npm`.
