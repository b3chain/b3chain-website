# b3chain-website

Static site for **b3chain**. Deploys to GitHub, IPFS, and ENS.

- **Repo:** [github.com/b3chain/b3chain-website](https://github.com/b3chain/b3chain-website)
- **GitHub Pages (optional):** `https://b3chain.github.io/b3chain-website/`
- **ENS (when set):** [b3chain.eth](https://b3chain.eth.link)

## Structure

```
b3chain-website/
├── index.html       # Main placeholder page
├── favicon.svg      # Icon (SVG, IPFS-friendly)
├── favicon.ico      # Optional (add if needed)
├── css/
│   └── style.css    # Styles
├── docs/
│   └── README.md    # Future documentation
└── README.md        # This file
```

Static HTML/CSS plus one small script for the footer year. Fine to pin on IPFS.

## Quick deploy

### 1. GitHub

```bash
git init
git add .
git commit -m "Initial B3 Chain placeholder page"
git branch -M main
git remote add origin https://github.com/b3chain/b3chain-website.git
git push -u origin main
```

**Optional:** Settings → Pages → Deploy from branch `main` → `https://b3chain.github.io/b3chain-website/`

### 2. IPFS

```bash
ipfs init                    # once
ipfs add -r ./b3chain-website
```

Use the **root hash** (last line, e.g. `Qm...`) to open:

- `https://ipfs.io/ipfs/<QmHashRoot>/`

### 3. ENS

If you own **b3chain.eth**:

1. Open [app.ens.domains](https://app.ens.domains)
2. Select the name → **Edit** → **Content hash**
3. Set content hash to your IPFS folder root: `QmHashRoot`

Then the site is available at **b3chain.eth.link** (and in ENS-enabled browsers).

### 4. Optional

- **Multi-sig:** Store ENS/domain admin keys in a 2-of-3 (or similar) multi-sig.
- **Gateways:** Mirror with Pinata, Cloudflare IPFS, etc.
- **Subdomains:** e.g. `docs.b3chain.eth`, `bin.b3chain.eth` for docs/binaries.

## Updating

1. Update files in this repo and push to GitHub.
2. Re-add folder to IPFS: `ipfs add -r ./b3chain-website`
3. Update ENS content hash to the new root hash.

---

No foundation, no single point of control. Verify; don’t trust.
