# Hipos local store prototype

Requires Node.js 18 or newer. No npm packages are needed.

## Run on your computer

Open PowerShell in this folder and run:

    node server.js

Then open http://127.0.0.1:3000/
Admin panel: http://127.0.0.1:3000/admin

Local prototype credentials: admin / admin.

## Public deployment outline

The app can run as a Node.js web service. For example, connect a private GitHub repository to Render, set the build command to npm install and the start command to node server.js.

Configure these service environment variables in Render:

- HOST=0.0.0.0
- PORT is provided by Render automatically
- ADMIN_USER=choose-a-new-login
- ADMIN_PASSWORD=choose-a-long-unique-password
- SECURE_COOKIE=true
- DATA_DIR=/var/data

Attach a persistent disk mounted at /var/data. Without persistent storage, catalog edits and new orders may be lost when the service restarts or redeploys. Render persistent disks require a paid web service. The service will receive a temporary onrender.com URL; add a custom domain later if desired.

Do not commit data/orders.json or customer details. The .gitignore excludes orders.json. Keep the GitHub repository private. A public deployment must use new admin credentials; the server refuses a non-local bind with the default admin/admin password or without secure cookies.

## Store readiness

The linked Wikkeo seller page currently shows no listed products. data/products.json is empty so Hipos will not advertise sample products as supplier stock. Add products manually in the admin panel once the seller provides exact details and image URLs. The product editor supports up to eight photo URLs and the supplier's product page link.

Wikkeo documents a dropshipping workflow, but this Hipos app currently records customer orders for manual processing; it does not send them to Wikkeo or collect payment. Confirm with the seller that your account is authorized for dropshipping, and agree on price, stock, minimum order, shipping, returns, and image permissions before accepting public orders.
