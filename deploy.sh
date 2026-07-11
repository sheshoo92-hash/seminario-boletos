#!/bin/bash
set -e

OUTPUTS_DIR="/Users/sergioalvarezreaza/Library/Application Support/Claude/local-agent-mode-sessions/12081d45-b4ea-45b5-b51c-43ba5666cfac/0ff550bb-0bcb-4d7b-9782-43f07fcaed32/local_d9ade214-38c2-4a7b-a6b1-81eddd357974/outputs"

cd "$OUTPUTS_DIR"

echo ""
echo "========================================"
echo "  DEPLOY — Seminario Boletos"
echo "========================================"
echo ""

# 1. Instalar GitHub CLI si no está
if ! command -v gh &> /dev/null; then
  echo "▶ Instalando GitHub CLI..."
  brew install gh
else
  echo "✔ GitHub CLI ya instalado"
fi

# 2. Login en GitHub (abre el navegador)
echo ""
echo "▶ Iniciando sesión en GitHub..."
echo "  (Se abrirá el navegador — autoriza la aplicación)"
echo ""
gh auth login --web --git-protocol https

# 3. Inicializar git
echo ""
echo "▶ Preparando repositorio..."
git init
echo "node_modules/" > .gitignore
echo ".env" >> .gitignore
echo "data.json" >> .gitignore
echo "archivos/" >> .gitignore
echo "public/uploads/" >> .gitignore

git add .
git commit -m "Seminario boletos - deploy inicial" 2>/dev/null || git commit --allow-empty -m "Seminario boletos - deploy inicial"

# 4. Crear repo en GitHub y subir código
echo ""
echo "▶ Creando repositorio en GitHub y subiendo código..."
gh repo create seminario-boletos --public --source=. --remote=origin --push --description "Sistema de boletos para seminario"

echo ""
echo "========================================"
echo "✅ Código subido a GitHub"
echo ""
echo "Ahora ve a: https://railway.app"
echo "  1. Login with GitHub"
echo "  2. New Project → Deploy from GitHub repo"
echo "  3. Selecciona 'seminario-boletos'"
echo "  4. Agrega estas variables de entorno:"
echo "     DATA_DIR=/data"
echo "     UPLOADS_DIR=/data/uploads"
echo "  5. Add Volume → Mount path: /data"
echo "  6. Settings → Domain → Generate Domain"
echo "     Copia la URL y agrégala como:"
echo "     BASE_URL=https://tu-url.railway.app"
echo "========================================"
echo ""
