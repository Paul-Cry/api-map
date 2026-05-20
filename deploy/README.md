# Р”РµРїР»РѕР№ СЂРµР№С‚РёРЅРіР° РєРІР°СЂС‚РёСЂ РЅР° VDS

Р’ РїР°РїРєРµ Р»РµР¶РёС‚ РіРѕС‚РѕРІС‹Р№ СЃС‚Р°С‚РёС‡РµСЃРєРёР№ СЃР°Р№С‚:

- `index.html` - СЃР°РјР° СЃС‚СЂР°РЅРёС†Р° СЂРµР№С‚РёРЅРіР°
- `app.js` - Node.js СЃРµСЂРІРµСЂ Р±РµР· Р·Р°РІРёСЃРёРјРѕСЃС‚РµР№
- `package.json` - РєРѕРјР°РЅРґР° Р·Р°РїСѓСЃРєР° РґР»СЏ Node.js
- `Dockerfile` - СЃР±РѕСЂРєР° nginx-РєРѕРЅС‚РµР№РЅРµСЂР°
- `docker-compose.yml` - Р±С‹СЃС‚СЂС‹Р№ Р·Р°РїСѓСЃРє РЅР° РїРѕСЂС‚Сѓ `8080`
- `nginx.conf` - РєРѕРЅС„РёРі nginx РІРЅСѓС‚СЂРё РєРѕРЅС‚РµР№РЅРµСЂР°

## Р’Р°СЂРёР°РЅС‚ 1: Node.js

РЎРєРѕРїРёСЂСѓР№ РїР°РїРєСѓ `deploy` РЅР° СЃРµСЂРІРµСЂ, РЅР°РїСЂРёРјРµСЂ РІ `/opt/apartments-ranking`, Р·Р°С‚РµРј:

```bash
cd /opt/apartments-ranking
npm start
```

РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ СЃР°Р№С‚ Р±СѓРґРµС‚ РґРѕСЃС‚СѓРїРµРЅ РЅР° РїРѕСЂС‚Сѓ `3000`:

```text
http://SERVER_IP:3000
```

Р§С‚РѕР±С‹ Р·Р°РїСѓСЃС‚РёС‚СЊ РЅР° РґСЂСѓРіРѕРј РїРѕСЂС‚Сѓ:

```bash
PORT=8080 npm start
```

## Р—Р°РїСѓСЃРє С‡РµСЂРµР· PM2

Р§С‚РѕР±С‹ СЃР°Р№С‚ СЂР°Р±РѕС‚Р°Р» РїРѕСЃС‚РѕСЏРЅРЅРѕ:

```bash
npm install -g pm2
cd /opt/apartments-ranking
pm2 start app.js --name apartments-ranking
pm2 save
pm2 startup
```

## РџСЂРѕРєСЃРёСЂРѕРІР°РЅРёРµ С‡РµСЂРµР· nginx

Р•СЃР»Рё РµСЃС‚СЊ РґРѕРјРµРЅ, РјРѕР¶РЅРѕ РѕСЃС‚Р°РІРёС‚СЊ Node.js РЅР° `3000`, Р° nginx РїРѕСЃС‚Р°РІРёС‚СЊ РїРµСЂРµРґ РЅРёРј:

```nginx
server {
    listen 80;
    server_name your-domain.ru;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Р’Р°СЂРёР°РЅС‚ 2: Docker Compose

РЎРєРѕРїРёСЂСѓР№ РїР°РїРєСѓ `deploy` РЅР° СЃРµСЂРІРµСЂ, РЅР°РїСЂРёРјРµСЂ РІ `/opt/apartments-ranking`, Р·Р°С‚РµРј:

```bash
cd /opt/apartments-ranking
docker compose up -d --build
```

РџРѕСЃР»Рµ Р·Р°РїСѓСЃРєР° СЃР°Р№С‚ Р±СѓРґРµС‚ РґРѕСЃС‚СѓРїРµРЅ:

```text
http://SERVER_IP:8080
```

Р•СЃР»Рё РЅСѓР¶РµРЅ РґРѕРјРµРЅ, РїСЂРѕРєРёРЅСЊ РґРѕРјРµРЅ С‡РµСЂРµР· РІРЅРµС€РЅРёР№ nginx РЅР° `127.0.0.1:8080`.

## Р’Р°СЂРёР°РЅС‚ 3: РѕР±С‹С‡РЅС‹Р№ nginx Р±РµР· Docker

РЎРєРѕРїРёСЂСѓР№ С„Р°Р№Р»:

```bash
sudo mkdir -p /var/www/apartments-ranking
sudo cp index.html /var/www/apartments-ranking/index.html
```

РЎРѕР·РґР°Р№ РєРѕРЅС„РёРі `/etc/nginx/sites-available/apartments-ranking`:

```nginx
server {
    listen 80;
    server_name your-domain.ru;

    root /var/www/apartments-ranking;
    index index.html;
    charset utf-8;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Р’РєР»СЋС‡Рё СЃР°Р№С‚ Рё РїРµСЂРµР·Р°РіСЂСѓР·Рё nginx:

```bash
sudo ln -s /etc/nginx/sites-available/apartments-ranking /etc/nginx/sites-enabled/apartments-ranking
sudo nginx -t
sudo systemctl reload nginx
```

## РћР±РЅРѕРІР»РµРЅРёРµ РґР°РЅРЅС‹С…

РљРѕРіРґР° РёР·РјРµРЅРёС€СЊ С‚Р°Р±Р»РёС†Сѓ Р»РѕРєР°Р»СЊРЅРѕ, Р·Р°РЅРѕРІРѕ СЃРєРѕРїРёСЂСѓР№ СЃРІРµР¶РёР№ `index.html` РЅР° СЃРµСЂРІРµСЂ Рё РїРµСЂРµР·Р°РїСѓСЃС‚Рё РєРѕРЅС‚РµР№РЅРµСЂ РёР»Рё reload nginx.

