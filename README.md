# F-Shop — menus et commandes de repas

Plateforme web qui remplace les commandes éparpillées dans WhatsApp :

| Profil | Ce qu'il peut faire |
|---|---|
| **Vendeuse** (`vendor`) | Créer son point de vente (position sur la carte), créer son catalogue de plats (avec photo) une fois pour toutes, **choisir chaque jour les plats disponibles** (avec un nombre de portions facultatif, ou en reprenant le menu de la veille), publier un message / une **capture d'écran du menu**, recevoir toutes les commandes au même endroit avec la **localisation GPS du client** (lien Google Maps, itinéraire, WhatsApp) et suivre leur statut. |
| **Client** (`client`) | Voir les menus **d'aujourd'hui ou de demain**, trouver les points de vente **proches** (carte + distance), s'y rendre (itinéraire) ou **commander** en livraison (position actuelle ou point placé sur la carte) ou à emporter. Onglet spécial **« Menus nutritionniste »** pour réserver des menus diététiques. |
| **Patient** (compte `client`) | Onglet « Mon suivi santé » : plans alimentaires personnalisés, **rappels de repas** qu'il peut modifier lui-même (heure, jours, activation), notifications navigateur, demande de **consultation à distance** (vidéo Jitsi, téléphone, messagerie), messagerie avec le nutritionniste. |
| **Nutritionniste** (`nutritionist`) | Suivre ses patients (notes privées), créer des **plans alimentaires personnalisés** qui génèrent automatiquement les rappels, gérer les rappels du patient, planifier les consultations (lien visio auto), messagerie, **proposer des menus préparés par un service spécialisé, sur réservation** (places limitées). |
| **Service spécialisé** (`service`) | Voir et traiter les réservations des menus qu'il doit préparer. |

## Démarrer

Prérequis : Node.js ≥ 22.13 (SQLite intégré à Node, aucune base à installer).

```bash
npm install
npm run seed   # facultatif : données de démo (mot de passe : demo123)
npm start      # http://localhost:3000
```

Comptes de démo : `rose@demo.cm` (vendeuse), `client@demo.cm` (client/patient),
`nutri@demo.cm` (nutritionniste), `cuisine@demo.cm` (service spécialisé).

Variables d'environnement : `PORT` (3000 par défaut), `HOST`, `DB_FILE` (par défaut `data/fshop.db`), `UPLOAD_DIR` (par défaut `uploads/`).

Tests : `npm test`

## Déploiement sur un serveur (Ubuntu / Debian)

Connecté en root au serveur :

```bash
curl -fsSL https://raw.githubusercontent.com/Efraim0601/F_shop/claude/meal-ordering-platform-c3oibb/deploy/install.sh -o install.sh
SEED=1 bash install.sh
```

Le script installe Node.js 22, nginx et l'application (`/opt/f-shop`, données dans `/var/lib/f-shop`), crée le service `f-shop`, puis tente d'obtenir un certificat HTTPS. Le HTTPS est indispensable pour la géolocalisation sur téléphone. Sans nom de domaine, le script utilise `<ip>.sslip.io`, qui pointe automatiquement vers le serveur. L'adresse finale s'affiche à la fin de l'installation.

Options : `DOMAIN=mon-domaine.cm`, `EMAIL=moi@exemple.com`, `HTTPS=0`, `SEED=1` (comptes de démo).

- Mise à jour : `bash /opt/f-shop/deploy/update.sh`
- Journaux : `journalctl -u f-shop -f`

## Architecture

- `src/app.js` — serveur Express, upload d'images (multer, 5 Mo max)
- `src/db.js` — schéma SQLite (`node:sqlite`)
- `src/routes/` — API REST : `auth`, `shops` (points de vente, plats, menu du jour, publications), `orders`, `nutrition` (patients, plans, rappels, consultations, messages, menus diététiques, réservations)
- `public/` — interface web mobile en JavaScript natif, cartes OpenStreetMap via Leaflet

Les cartes utilisent les tuiles OpenStreetMap ; sans connexion à `cdn.jsdelivr.net`, l'application fonctionne sans la carte (la géolocalisation du téléphone reste utilisée).

## Pistes suivantes

- Paiement mobile (Orange Money / MTN MoMo) à la commande
- Notifications push (Web Push) pour les rappels même quand la page est fermée, et SMS/WhatsApp à la vendeuse lors d'une nouvelle commande
- Application installable (PWA)
