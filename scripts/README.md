# Scripts

## Let's Encrypt (b3chain.org)

**install-letsencrypt.sh** — installs certbot, obtains a certificate for `b3chain.org` and `www.b3chain.org`, and adds a daily cron job to renew.

### On the server (Debian/Ubuntu or RHEL)

1. Ensure DNS for `b3chain.org` points to this machine.
2. For **standalone** (default): stop nginx/apache so port 80 is free, then:
   ```bash
   sudo ./install-letsencrypt.sh
   ```
3. If you already serve the site from a directory (e.g. nginx), use **webroot** so you don’t need to stop the server:
   ```bash
   sudo WEBROOT=/var/www/html ./install-letsencrypt.sh
   ```
   Use the path nginx uses as `root` for this vhost.

4. Configure your web server to use the certs (see below).

5. Test renewal: `sudo certbot renew --dry-run`

---

### Web server config

Certificate and key paths:

- **Certificate:** `/etc/letsencrypt/live/b3chain.org/fullchain.pem`
- **Private key:** `/etc/letsencrypt/live/b3chain.org/privkey.pem`

(These are symlinks; certbot updates them on renewal. Use these paths in the server config.)

#### Nginx

Example server block for HTTPS. Redirect HTTP to HTTPS so Let’s Encrypt renewal over port 80 still works.

**HTTP (redirect to HTTPS):**  
Create or edit a server block for port 80, e.g. `/etc/nginx/sites-available/b3chain.org`:

```nginx
server {
    listen 80;
    server_name b3chain.org www.b3chain.org;
    # Let certbot use /.well-known/acme-challenge/ for renewal
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
```

**HTTPS:**  
Add a second server block (or the same file) for 443:

```nginx
server {
    listen 443 ssl;
    server_name b3chain.org www.b3chain.org;

    ssl_certificate     /etc/letsencrypt/live/b3chain.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/b3chain.org/privkey.pem;

    root /var/www/html;   # or wherever your b3chain-website files are
    index index.html;
    location / {
        try_files $uri $uri/ =404;
    }
}
```

Then enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/b3chain.org /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

#### Apache

Enable `ssl` and `rewrite`, then use a vhost like this.

**HTTP (redirect):**  
In `/etc/apache2/sites-available/b3chain.org.conf` (or equivalent):

```apache
<VirtualHost *:80>
    ServerName b3chain.org
    ServerAlias www.b3chain.org
    DocumentRoot /var/www/html
    <Location /.well-known/acme-challenge/>
        Require all granted
    </Location>
    RewriteEngine On
    RewriteCond %{HTTPS} off
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>
```

**HTTPS:**  
Same file or a separate one (e.g. port 443):

```apache
<VirtualHost *:443>
    ServerName b3chain.org
    ServerAlias www.b3chain.org
    DocumentRoot /var/www/html

    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/b3chain.org/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/b3chain.org/privkey.pem
</VirtualHost>
```

Enable site and reload:

```bash
sudo a2enmod ssl rewrite
sudo a2ensite b3chain.org.conf
sudo apachectl configtest && sudo systemctl reload apache2
```

Change `DocumentRoot` / `root` to the directory where your b3chain-website files (e.g. `index.html`) live.

Email for expiry notices: **admin@b3chain.org**.
