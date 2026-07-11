#!/bin/bash
cd "/Users/sergioalvarezreaza/Library/Application Support/Claude/local-agent-mode-sessions/12081d45-b4ea-45b5-b51c-43ba5666cfac/0ff550bb-0bcb-4d7b-9782-43f07fcaed32/local_d9ade214-38c2-4a7b-a6b1-81eddd357974/outputs"

echo ""
echo "========================================"
echo "  Subiendo Seminario Boletos a internet"
echo "========================================"

# Instalar GitHub CLI si no está
if ! command -v gh &> /dev/null; then
  echo "▶ Instalando GitHub CLI (requiere Homebrew)..."
  if ! command -v brew &> /dev/null; then
    echo "Instalando Homebrew primero..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  brew install gh
fi

echo "▶ Iniciando sesión en GitHub (se abrirá el navegador)..."
gh auth login --web --git-protocol https

echo "▶ Preparando código..."
git init
git add .
git commit -m "Seminario boletos inicial" 2>/dev/null || true

echo "▶ Creando repositorio y subiendo código..."
gh repo create seminario-boletos --public --source=. --remote=origin --push --description "Sistema de boletos seminario" 2>/dev/null || \
gh repo create seminario-boletos-amway --public --source=. --remote=origin --push --description "Sistema de boletos seminario"

echo ""
echo "✅ LISTO — Código en GitHub"
echo ""
echo "Ahora avísale a Claude para configurar Railway."
echo ""
read -p "Presiona Enter para cerrar..."
