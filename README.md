# Contacts

A contacts / address-book web app. List, view, add, edit and delete contacts; each contact can have multiple email addresses.

**Live site:** [contacts-app-riggs.onrender.com](https://contacts-app-riggs.onrender.com)

_Hosted on Render's free tier: the first visit after a period of inactivity can take up to a minute while the server wakes up, and the demo data resets when the server restarts._

## Tech stack

- **Frontend:** JavaScript, HTML, CSS
- **Backend:** Python, FastAPI, SQLModel
- **Database:** SQLite

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open <http://localhost:8000>. API docs are at <http://localhost:8000/docs>.

## Project structure

```
main.py            # FastAPI app: database models, validation, REST API, serves the frontend
requirements.txt   # Python dependencies
test_api.py        # API tests
static/
  index.html       # page markup
  styles.css       # styling (based on the Figma mockup)
  app.js           # frontend logic
```

## Testing

`test_api.py` tests the REST API against a running server. It uses only the Python standard library, so there is nothing extra to install, and it deletes any contacts it creates.

```bash
# against a local server (start it first with: uvicorn main:app --reload)
python3 test_api.py

# against the live site
python3 test_api.py https://contacts-app-riggs.onrender.com
```

It covers creating, reading, updating, deleting and searching contacts; validation (required names, email format, duplicate emails, phone numbers); and the vCard export.

## API

| Method | Endpoint                     | Description               |
|--------|------------------------------|---------------------------|
| GET    | `/api/contacts?q=`           | List / search contacts    |
| GET    | `/api/contacts/{id}`         | Get one contact           |
| POST   | `/api/contacts`              | Create a contact          |
| PUT    | `/api/contacts/{id}`         | Update a contact          |
| DELETE | `/api/contacts/{id}`         | Delete a contact          |
| GET    | `/api/contacts/{id}/vcard`   | Download contact as vCard |
