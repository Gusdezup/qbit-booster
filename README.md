# Qbit Booster

Userscript (Violentmonkey / Tampermonkey) qui ajoute au WebUI de qBittorrent :

- **Créateur de torrent amélioré** — remplace la fenêtre native : taille de pièce, format v1/v2/hybride, privé par défaut, trackers enregistrés (nom, URL, champ *source*), navigateur de fichiers avec autocomplétion, préremplissage depuis le torrent sélectionné, téléchargement du `.torrent`.
- **Éditeur de trackers en masse** — remplace une URL d'announce sur tous les torrents concernés (sélection, filtre tracker de la barre latérale, ou toute la bibliothèque).
- **Réinitialisation des filtres** — un clic remet État, Catégories, Étiquettes et Trackers sur « Tous » ; l'icône passe en orange dès qu'un filtre est actif (survol = lesquels).
- **MediaInfo** *(optionnel)* — affiche la sortie `mediainfo` d'un fichier d'un torrent, copie ou export `.nfo`. Nécessite le petit conteneur `qbit-booster-mediainfo`.

## Prérequis

- qBittorrent **5.0+** (API `torrentcreator`). **5.1+** recommandé : l'éditeur de trackers récupère tout en une seule requête (sinon, repli sur un scan torrent par torrent, plus lent).
- Violentmonkey (recommandé) ou Tampermonkey.
- Aucun identifiant à fournir : le script tourne dans la page du WebUI et réutilise ta session.

## Installation

1. Clique sur **[qbit-booster.user.js](https://raw.githubusercontent.com/Gusdezup/qbit-booster/main/qbit-booster.user.js)** : l'extension propose l'installation.
2. Déclare l'adresse de **ton** WebUI :
   - **Violentmonkey** : tableau de bord → *Modifier* le script → onglet *Paramètres* → *Règles @match* → ajoute par ex. `http://192.168.1.10:8080/*` (garde « Garder l'original » coché) → Enregistrer.
   - **Tampermonkey** : *Paramètres* du script → *Correspondances utilisateur* → même valeur.

   Le `/*` final est obligatoire. Ce réglage survit aux mises à jour.
3. Recharge le WebUI.

Les mises à jour sont automatiques (via `@updateURL`).

### Tu avais l'ancienne version (qbt-webui-toolbox) ?

Le script a été renommé : l'ancienne adresse ne reçoit plus de mises à jour.

1. Dans l'ancien script : menu de l'extension → **Trackers : importer / exporter…** → copie le JSON.
2. Installe **Qbit Booster** (lien ci-dessus) et redéclare ton `@match`.
3. Supprime l'ancien script, puis colle ton JSON dans **Trackers : importer / exporter…** → **Importer**. Refais tes **Réglages…** (URL du sidecar, etc.).

## Réglages

Menu de l'extension → **Réglages…**, ou bouton **⚙ Réglages** dans la fenêtre du créateur :

| Réglage | Défaut |
|---|---|
| URL du sidecar MediaInfo (vide = bouton masqué) | vide |
| Taille des pièces | 4 MiB |
| Format | v1 |
| Torrent privé / démarrer le seed | oui / oui |
| Masquer les flèches de file d'attente | non |

## MediaInfo (optionnel)

Le navigateur ne peut pas lire les fichiers du serveur : un conteneur `qbit-booster-mediainfo` exécute `mediainfo` à sa place.

Ajoute ce service au `docker-compose.yml` qui contient qBittorrent (voir [`docker-compose.example.yml`](docker-compose.example.yml)) :

```yaml
  qbit-booster-mediainfo:
    image: ghcr.io/gusdezup/qbit-booster-mediainfo:latest
    container_name: qbit-booster-mediainfo
    user: "1000:1000"            # mêmes PUID/PGID que qBittorrent
    environment:
      - ALLOWED_ROOT=/media
    volumes:
      - /chemin/vers/tes/medias:/media:ro
    ports:
      - "8765:8765"
    restart: unless-stopped
```

Puis `docker compose up -d qbit-booster-mediainfo`, et dans **Réglages…** du script : `http://IP-DU-SERVEUR:8765` → **Tester** → **Enregistrer**.

**Point essentiel :** le volume doit être monté **au même chemin dans le conteneur** que dans qBittorrent. Si qBittorrent voit tes fichiers sous `/downloads`, monte-les aussi sous `/downloads` et mets `ALLOWED_ROOT=/downloads`.

Variables : `ALLOWED_ROOT` (défaut `/media`), `PORT` (8765), `MEDIAINFO_TIMEOUT` en secondes (60).

### Sécurité

- Le sidecar n'a **pas d'authentification** : ne l'expose **qu'en réseau local**, jamais sur Internet.
- Il refuse tout chemin hors de `ALLOWED_ROOT` (liens symboliques et `..` résolus) et ne lit que des fichiers. Monte les médias en lecture seule (`:ro`).

## Dépannage

- **Aucun bouton n'apparaît** : l'adresse du WebUI n'est pas dans les règles `@match`.
- **Boutons en double** : l'ancien script (qbt-webui-toolbox) est encore actif, supprime-le.
- **MediaInfo : « Injoignable »** : vérifie IP/port et que le conteneur tourne (`curl http://IP:8765/health` → `ok`).
- **MediaInfo : « Fichier introuvable »** : chemins de montage différents entre qBittorrent et le sidecar.
- **Éditeur de trackers lent** : qBittorrent < 5.1.

## Licence

MIT
