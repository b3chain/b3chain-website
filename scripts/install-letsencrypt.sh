#!/usr/bin/env bash
#
# Install Let's Encrypt (certbot), obtain a certificate for b3chain.org,
# configure the web server (nginx or apache) for HTTPS + HTTP redirect,
# and set up daily renewal via cron.
#
# Usage: sudo ./install-letsencrypt.sh
#
# Prerequisites:
# - b3chain.org must DNS-resolve to this machine.
# - Port 80 must be free for the initial request (stop nginx/apache if needed),
#   or set WEBROOT and use an existing web root (see below).
#
# Domain: b3chain.org, www.b3chain.org
# Email:  admin@b3chain.org
#
# Optional env:
#   WEBROOT=/var/www/html   use webroot for certbot (and as doc root if DOCROOT unset)
#   DOCROOT=/var/www/html   where site files are served from (default: WEBROOT or /var/www/html)
#   WEBSERVER=nginx|apache  force which server to configure (default: auto-detect)
#   SKIP_DRY_RUN=1          skip running certbot renew at the end
#   FIX_CONFIG=1            only write and verify nginx/apache config (skip certbot, cron, renew)

set -e

DOMAIN="b3chain.org"
EMAIL="admin@b3chain.org"
CRON_SCHEDULE="0 3 * * *"   # 03:00 every day
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}"
FULLCHAIN="${CERT_PATH}/fullchain.pem"
PRIVKEY="${CERT_PATH}/privkey.pem"

# Optional: if set, use webroot mode for certbot (no need to free port 80).
WEBROOT="${WEBROOT:-}"
DOCROOT="${DOCROOT:-${WEBROOT:-/var/www/html}}"
WEBSERVER="${WEBSERVER:-}"
# Set SKIP_DRY_RUN=1 to skip the renewal dry-run at the end.
SKIP_DRY_RUN="${SKIP_DRY_RUN:-0}"
# Set FIX_CONFIG=1 to only update and verify web server config (HTTP→HTTPS); skip certbot, cron, renew.
FIX_CONFIG="${FIX_CONFIG:-0}"

# ---

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ "$FIX_CONFIG" == "1" ]]; then
  echo "[*] FIX_CONFIG=1: only updating and verifying web server config (skip certbot)."
  DOCROOT="${DOCROOT:-${WEBROOT:-/var/www/html}}"
  CERT_PATH="/etc/letsencrypt/live/${DOMAIN}"
  FULLCHAIN="${CERT_PATH}/fullchain.pem"
  PRIVKEY="${CERT_PATH}/privkey.pem"
  # Fall through to webserver detection and config write below (skip certbot, cron, renew)
else
echo "[*] Installing certbot ..."

if command -v apt-get &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq certbot
elif command -v dnf &>/dev/null; then
  dnf install -y certbot
elif command -v yum &>/dev/null; then
  yum install -y certbot
else
  echo "Unsupported OS. Install certbot manually: https://certbot.eff.org"
  exit 1
fi

# With webroot, nginx must serve the webroot on port 80 *before* certbot runs (for ACME challenge).
# We enable ONLY a temporary HTTP-only config (and disable any existing full b3chain.org config
# so it doesn't take precedence and return 404), reload, run certbot, then write the full HTTPS config.
if [[ -n "$WEBROOT" && "$FIX_CONFIG" != "1" ]]; then
  if command -v nginx &>/dev/null && ( systemctl is-enabled nginx &>/dev/null 2>/dev/null || true ); then
    echo "[*] Temporary nginx config so Let's Encrypt can reach the webroot ..."
    SITE_NAME="b3chain.org"
    if [[ -d /etc/nginx/sites-available ]]; then
      FULL_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"
      TMP_CONFIG="/etc/nginx/sites-available/${SITE_NAME}-acme"
      TMP_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}-acme"
    else
      FULL_ENABLED=""
      TMP_CONFIG="/etc/nginx/conf.d/${SITE_NAME}-acme.conf"
      TMP_ENABLED="$TMP_CONFIG"
    fi
    # Disable full site so only the ACME block handles b3chain.org (avoids 404 when full block loads first)
    rm -f "$FULL_ENABLED" 2>/dev/null || true
    cat > "$TMP_CONFIG" << NGINX_ACME_EOF
# Temporary: port 80 only, so certbot webroot validation works. Replaced by full config after.
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    root ${WEBROOT};
    location /.well-known/acme-challenge/ {
        default_type text/plain;
        try_files \$uri =404;
    }
    location / {
        return 200 'OK';
        add_header Content-Type text/plain;
    }
}
NGINX_ACME_EOF
    if [[ -d /etc/nginx/sites-available ]]; then
      ln -sf "$TMP_CONFIG" "$TMP_ENABLED" 2>/dev/null || true
    fi
    nginx -t && systemctl reload nginx
    echo "    Reloaded nginx (only ACME block active for ${DOMAIN})."
  fi
fi

echo "[*] Obtaining certificate for ${DOMAIN} and www.${DOMAIN} ..."

if [[ "$FIX_CONFIG" != "1" ]]; then
  if [[ -n "$WEBROOT" ]]; then
    certbot certonly --webroot -w "$WEBROOT" \
      -d "$DOMAIN" -d "www.$DOMAIN" \
      --non-interactive --agree-tos -m "$EMAIL"
  else
    certbot certonly --standalone \
      -d "$DOMAIN" -d "www.$DOMAIN" \
      --non-interactive --agree-tos -m "$EMAIL"
  fi

  echo "[*] Setting up daily renewal (cron) ..."

CRON_CMD="certbot renew --quiet"
CRON_LINE="${CRON_SCHEDULE} root ${CRON_CMD}"

  if [[ -d /etc/cron.d ]]; then
    echo "$CRON_LINE" > /etc/cron.d/certbot-b3chain
    chmod 644 /etc/cron.d/certbot-b3chain
    echo "    Wrote /etc/cron.d/certbot-b3chain"
  else
    ( crontab -l 2>/dev/null | grep -v certbot; echo "${CRON_SCHEDULE} ${CRON_CMD}"; ) | crontab -
    echo "    Added to root crontab"
  fi
  fi
fi

# --- Configure web server: HTTPS + HTTP redirect, then enable, reload, and verify

detect_webserver() {
  if [[ -n "$WEBSERVER" ]]; then
    [[ "$WEBSERVER" == "nginx" || "$WEBSERVER" == "apache" ]] || { echo "WEBSERVER must be nginx or apache"; exit 1; }
    echo "$WEBSERVER"
    return
  fi
  if command -v nginx &>/dev/null && systemctl is-enabled nginx &>/dev/null 2>/dev/null; then
    echo "nginx"
    return
  fi
  if command -v apache2 &>/dev/null && systemctl is-enabled apache2 &>/dev/null 2>/dev/null; then
    echo "apache"
    return
  fi
  if command -v httpd &>/dev/null && systemctl is-enabled httpd &>/dev/null 2>/dev/null; then
    echo "apache"
    return
  fi
  echo ""
}

SERVER="$(detect_webserver)"

if [[ -z "$SERVER" ]]; then
  echo "[!] No nginx or apache detected. Configure your web server manually to use:"
  echo "    $FULLCHAIN"
  echo "    $PRIVKEY"
  echo "    (HTTP redirect to HTTPS, then enable and reload.)"
else
  echo "[*] Configuring $SERVER for HTTPS and HTTP→HTTPS redirect (doc root: $DOCROOT) ..."

  if [[ "$SERVER" == "nginx" ]]; then
    SITE_NAME="b3chain.org"
    if [[ -d /etc/nginx/sites-available ]]; then
      CONFIG="/etc/nginx/sites-available/${SITE_NAME}"
      ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"
    else
      CONFIG="/etc/nginx/conf.d/${SITE_NAME}.conf"
      ENABLED="$CONFIG"
    fi

    cat > "$CONFIG" << NGINX_EOF
# HTTP: redirect to HTTPS, keep acme-challenge for certbot
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    location /.well-known/acme-challenge/ {
        root ${DOCROOT};
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl;
    server_name ${DOMAIN} www.${DOMAIN};

    ssl_certificate     ${FULLCHAIN};
    ssl_certificate_key ${PRIVKEY};

    root ${DOCROOT};
    index index.html;
    location / {
        try_files \$uri \$uri/ =404;
    }
}
NGINX_EOF

    if [[ -d /etc/nginx/sites-available && ! -L "$ENABLED" ]]; then
      ln -sf "$CONFIG" "$ENABLED"
    fi
    # Remove temporary ACME-only config if we created it (webroot mode)
    if [[ -n "$WEBROOT" ]]; then
      rm -f /etc/nginx/sites-enabled/b3chain.org-acme /etc/nginx/sites-available/b3chain.org-acme /etc/nginx/conf.d/b3chain.org-acme.conf 2>/dev/null || true
    fi
    nginx -t || { echo "[!] nginx config test failed. Fix $CONFIG and run: nginx -t && systemctl reload nginx"; exit 1; }
    systemctl reload nginx
    echo "    Wrote $CONFIG, enabled, reloaded nginx."
    # Verify HTTP→HTTPS redirect
    REDIRECT_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" http://127.0.0.1/ 2>/dev/null || echo "000")"
    if [[ "$REDIRECT_CODE" == "301" ]]; then
      echo "    HTTP→HTTPS redirect verified (301)."
    else
      echo "    [!] HTTP redirect check got $REDIRECT_CODE (expected 301). Ensure no other server block catches ${DOMAIN} on port 80."
    fi
  fi

  if [[ "$SERVER" == "apache" ]]; then
    SITE_NAME="b3chain.org"
    if command -v a2ensite &>/dev/null; then
      CONFIG="/etc/apache2/sites-available/${SITE_NAME}.conf"
      ENABLE_CMD="a2ensite ${SITE_NAME}"
      RELOAD_CMD="systemctl reload apache2"
    else
      CONFIG="/etc/httpd/conf.d/${SITE_NAME}.conf"
      ENABLE_CMD="true"
      RELOAD_CMD="systemctl reload httpd"
    fi

    cat > "$CONFIG" << APACHE_EOF
# HTTP: redirect to HTTPS, keep acme-challenge for certbot
<VirtualHost *:80>
    ServerName ${DOMAIN}
    ServerAlias www.${DOMAIN}
    DocumentRoot ${DOCROOT}
    <Directory ${DOCROOT}>
        Require all granted
    </Directory>
    <Location /.well-known/acme-challenge/>
        Require all granted
    </Location>
    RewriteEngine On
    RewriteCond %{HTTPS} off
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

# HTTPS
<VirtualHost *:443>
    ServerName ${DOMAIN}
    ServerAlias www.${DOMAIN}
    DocumentRoot ${DOCROOT}

    SSLEngine on
    SSLCertificateFile      ${FULLCHAIN}
    SSLCertificateKeyFile   ${PRIVKEY}
</VirtualHost>
APACHE_EOF

    if command -v a2enmod &>/dev/null; then
      a2enmod ssl 2>/dev/null || true
      a2enmod rewrite 2>/dev/null || true
    fi
    $ENABLE_CMD
    if command -v apachectl &>/dev/null; then apachectl configtest 2>/dev/null; elif command -v httpd &>/dev/null; then httpd -t 2>/dev/null; fi || true
    $RELOAD_CMD
    echo "    Wrote $CONFIG, enabled, reloaded apache."
    REDIRECT_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" http://127.0.0.1/ 2>/dev/null || echo "000")"
    if [[ "$REDIRECT_CODE" == "301" ]]; then
      echo "    HTTP→HTTPS redirect verified (301)."
    else
      echo "    [!] HTTP redirect check got $REDIRECT_CODE (expected 301). Check RewriteRule in $CONFIG."
    fi
  fi
fi

if [[ "$FIX_CONFIG" != "1" && "$SKIP_DRY_RUN" != "1" ]]; then
  echo ""
  echo "[*] Running renewal (real) ..."
  if certbot renew --quiet 2>/dev/null; then
    echo "    Renewal completed (or cert not yet due)."
  else
    echo "    Renewal had issues (check with: sudo certbot renew -v)."
  fi
fi

echo ""
echo "Done. Certificate and chain:"
echo "  $FULLCHAIN"
echo "  $PRIVKEY"
echo ""
echo "Renewal runs daily at 03:00. Test: sudo certbot renew --dry-run; force: sudo certbot renew --force-renewal"
echo "To only fix/verify HTTP→HTTPS config: sudo FIX_CONFIG=1 DOCROOT=/var/www/b3chain ./install-letsencrypt.sh"
