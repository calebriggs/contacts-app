"""Contacts API: FastAPI + SQLModel + SQLite.

One process serves both the REST API (under /api) and the vanilla-JS frontend
(from ./static), so the whole app deploys as a single service.

Run locally:   uvicorn main:app --reload
"""

import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import EmailStr, ValidationInfo, field_validator
from sqlalchemy import UniqueConstraint, event, func, or_
from sqlalchemy.orm import selectinload
from sqlmodel import Field, Relationship, Session, SQLModel, col, create_engine, select

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'contacts.db'}")

MAX_EMAILS = 20
PHONE_CHARS_RE = re.compile(r"^\+?[0-9()\-.\s]+((x|ext\.?)\s*[0-9]{1,6})?$", re.IGNORECASE)
PHONE_EXT_RE = re.compile(r"(x|ext\.?)\s*[0-9]{1,6}$", re.IGNORECASE)
PHONE_DIGITS = (7, 15)  # 15 is the E.164 maximum for international numbers
FIELD_LABELS = {
    "first_name": "First name",
    "last_name": "Last name",
    "phone": "Phone",
    "company": "Company",
    "notes": "Notes",
    "emails": "Email",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Database models
# --------------------------------------------------------------------------- #
class Contact(SQLModel, table=True):
    # Never reuse the id of a deleted contact, so an old link (#/contacts/21)
    # can't silently open a different person.
    __table_args__ = {"sqlite_autoincrement": True}

    id: Optional[int] = Field(default=None, primary_key=True)
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)
    phone: Optional[str] = Field(default=None, max_length=40)
    company: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)
    favorite: bool = Field(default=False)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    # One contact -> many emails. Removing an email from the list (or deleting
    # the contact) deletes the row, so no orphaned emails are left behind.
    emails: List["Email"] = Relationship(
        back_populates="contact",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "order_by": "Email.position",
        },
    )


class Email(SQLModel, table=True):
    # A contact can't have the same address twice. Different contacts may share
    # one (e.g. a family inbox or a shared team address).
    __table_args__ = (UniqueConstraint("contact_id", "address"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    contact_id: int = Field(foreign_key="contact.id", index=True, ondelete="CASCADE")
    address: str = Field(max_length=254, index=True)
    position: int = Field(default=0)  # keeps the order the user entered them in

    contact: Optional[Contact] = Relationship(back_populates="emails")


# --------------------------------------------------------------------------- #
# API schemas
# --------------------------------------------------------------------------- #
class ContactIn(SQLModel):
    """Payload for create (POST) and full update (PUT)."""

    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)
    phone: Optional[str] = Field(default=None, max_length=40)
    company: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)
    favorite: bool = False
    emails: List[EmailStr] = Field(default_factory=list) #email validation for edge cases 

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def required_text(cls, value, info: ValidationInfo):
        value = value.strip() if isinstance(value, str) else value
        if not value:
            raise ValueError(f"{FIELD_LABELS[info.field_name]} is required")
        return value

    @field_validator("phone", "company", "notes", mode="before")
    @classmethod
    def blank_to_none(cls, value):
        if isinstance(value, str):
            value = value.strip()
        return value or None

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value):
        if not value:
            return value
        # Two separate checks, so the message says what is actually wrong.
        if not PHONE_CHARS_RE.match(value):
            raise ValueError("Phone can only contain digits, spaces and + ( ) - .")
        digits = sum(ch.isdigit() for ch in PHONE_EXT_RE.sub("", value))  # extension not counted
        if not PHONE_DIGITS[0] <= digits <= PHONE_DIGITS[1]:
            raise ValueError(f"Phone number must have between {PHONE_DIGITS[0]} and {PHONE_DIGITS[1]} digits")
        return value

    @field_validator("emails", mode="before")
    @classmethod
    def strip_emails(cls, value):
        if isinstance(value, list):
            return [v.strip() if isinstance(v, str) else v for v in value]
        return value

    @field_validator("emails")
    @classmethod
    def unique_emails(cls, value):
        if len(value) > MAX_EMAILS:
            raise ValueError(f"A contact can have at most {MAX_EMAILS} emails")
        seen = set()
        for address in value:
            key = address.lower()
            if key in seen:
                raise ValueError(f"{address} is listed more than once")
            seen.add(key)
        return value


class ContactOut(SQLModel):
    id: int
    first_name: str
    last_name: str
    phone: Optional[str]
    company: Optional[str]
    notes: Optional[str]
    favorite: bool
    emails: List[str]
    created_at: datetime
    updated_at: datetime


class ContactSummary(SQLModel):
    """The lightweight shape used by the sidebar list."""

    id: int
    first_name: str
    last_name: str
    company: Optional[str]
    favorite: bool
    email: Optional[str]  # hover → "Craggy Bramble · craggy.bramble@gmail.com"


def to_out(contact: Contact) -> ContactOut:
    return ContactOut(
        **contact.model_dump(exclude={"emails"}),
        emails=[e.address for e in contact.emails],
    )


def apply_changes(contact: Contact, data: ContactIn) -> None:
    for field in ("first_name", "last_name", "phone", "company", "notes", "favorite"):
        setattr(contact, field, getattr(data, field))

    # Reuse rows for addresses that are still there, so the update is a minimal
    # diff instead of a delete-everything-and-reinsert.
    existing = {e.address.lower(): e for e in contact.emails}
    updated = []
    for position, address in enumerate(data.emails):
        email = existing.pop(address.lower(), None) or Email(address=address)
        email.address = address
        email.position = position
        updated.append(email)
    contact.emails = updated  # anything left in `existing` is deleted (orphan)
    contact.updated_at = utcnow()


# --------------------------------------------------------------------------- #
# Database setup
# --------------------------------------------------------------------------- #
is_sqlite = DATABASE_URL.startswith("sqlite")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if is_sqlite else {},
)

if is_sqlite:

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _record):
        # SQLite ignores foreign keys (and ON DELETE CASCADE) unless asked.
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def get_session():
    with Session(engine) as session:
        yield session


DEMO_CONTACTS = [
    ("Andra", "Inde"), ("Archibald", "Burns"), ("Berk", "Carruth"),
    ("Craggy", "Bramble"), ("Davita", "de Juares"), ("Dione", "Gibbett"),
    ("Federico", "Baynham"), ("Fifi", "Soitoux"), ("Florinda", "O'Connell"),
    ("Gerry", "Deaville"), ("Gorden", "Maleney"), ("Jackie", "Gritton"),
    ("Killy", "Akitt"), ("Lavinie", "Nevett"), ("Meggie", "Stetson"),
    ("Nedi", "Cray"), ("Raddie", "Sear"), ("Sarina", "Scrace"),
    ("Theobald", "Marczyk"), ("Tudor", "Marcham"),
]


def seed_demo_data(session: Session) -> None:
    """Fill a brand-new database with the people from the design mockup."""
    for first, last in DEMO_CONTACTS:
        emails = [f"{first.lower()}.{re.sub(r'[^a-z]', '', last.lower())}@example.com"]
        if (first, last) == ("Craggy", "Bramble"):
            emails = ["craggy.bramble@gmail.com", "cbramble@marcham.com", "craggy3029@yahoo.com"]
        contact = Contact(first_name=first, last_name=last)
        contact.emails = [Email(address=a, position=i) for i, a in enumerate(emails)]
        session.add(contact)
    session.commit()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Only seed a database that is being created right now. If a user later
    # deletes every contact, a restart must not bring the demo people back.
    db_file = engine.url.database if is_sqlite else None
    brand_new = bool(db_file) and db_file != ":memory:" and not Path(db_file).exists()
    SQLModel.metadata.create_all(engine)
    if brand_new and os.getenv("SEED_DEMO_DATA", "true").lower() == "true":
        with Session(engine) as session:
            seed_demo_data(session)
    yield


# --------------------------------------------------------------------------- #
# App + routes
# --------------------------------------------------------------------------- #
app = FastAPI(title="Contacts", version="1.0.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError):
    """Turn Pydantic errors into {field: message} so the UI can show them inline."""
    errors = {}
    for err in exc.errors():
        loc = [str(part) for part in err["loc"] if part != "body"]
        field = loc[0] if loc else "body"
        label = FIELD_LABELS.get(field, field.replace("_", " ").capitalize())
        msg = err["msg"].removeprefix("Value error, ")
        if err["type"] == "missing":
            msg = f"{label} is required"
        elif err["type"] == "string_too_long":
            msg = f"{label} must be at most {err['ctx']['max_length']} characters"
        elif field == "emails" and len(loc) > 1:
            msg = f"{err.get('input')} is not a valid email address"
        errors.setdefault(".".join(loc) or field, msg)
    return JSONResponse(
        status_code=422,
        content={"detail": "Please fix the highlighted fields.", "errors": errors},
    )


def get_contact_or_404(contact_id: int, session: Session) -> Contact:
    contact = session.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    return contact


@app.get("/api/contacts", response_model=List[ContactSummary])
def list_contacts(
    q: Optional[str] = Query(default=None, max_length=100, description="Search text"),
    session: Session = Depends(get_session),
):
    stmt = select(Contact).options(selectinload(Contact.emails))
    # Every word must match somewhere, so "craggy gmail" narrows instead of widening.
    for term in (q or "").split():
        like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(
            or_(
                col(Contact.first_name).ilike(like, escape="\\"),
                col(Contact.last_name).ilike(like, escape="\\"),
                col(Contact.company).ilike(like, escape="\\"),
                col(Contact.phone).ilike(like, escape="\\"),
                Contact.emails.any(col(Email.address).ilike(like, escape="\\")),
            )
        )
    stmt = stmt.order_by(func.lower(Contact.first_name), func.lower(Contact.last_name))
    return [
        ContactSummary(
            id=c.id,
            first_name=c.first_name,
            last_name=c.last_name,
            company=c.company,
            favorite=c.favorite,
            email=c.emails[0].address if c.emails else None,
        )
        for c in session.exec(stmt).all()
    ]


@app.get("/api/contacts/{contact_id}", response_model=ContactOut)
def get_contact(contact_id: int, session: Session = Depends(get_session)):
    return to_out(get_contact_or_404(contact_id, session))


@app.post("/api/contacts", response_model=ContactOut, status_code=status.HTTP_201_CREATED)
def create_contact(data: ContactIn, session: Session = Depends(get_session)):
    contact = Contact(first_name=data.first_name, last_name=data.last_name)
    apply_changes(contact, data)
    session.add(contact)
    session.commit()
    session.refresh(contact)
    return to_out(contact)


@app.put("/api/contacts/{contact_id}", response_model=ContactOut)
def update_contact(contact_id: int, data: ContactIn, session: Session = Depends(get_session)):
    contact = get_contact_or_404(contact_id, session)
    apply_changes(contact, data)
    session.add(contact)
    session.commit()
    session.refresh(contact)
    return to_out(contact)


@app.delete("/api/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(contact_id: int, session: Session = Depends(get_session)):
    session.delete(get_contact_or_404(contact_id, session))
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _vcard_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")
    )


@app.get("/api/contacts/{contact_id}/vcard")
def export_vcard(contact_id: int, session: Session = Depends(get_session)):
    """Download a contact as a .vcf so it can be imported into a phone or mail app."""
    c = get_contact_or_404(contact_id, session)
    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        f"N:{_vcard_escape(c.last_name)};{_vcard_escape(c.first_name)};;;",
        f"FN:{_vcard_escape(f'{c.first_name} {c.last_name}')}",
    ]
    if c.company:
        lines.append(f"ORG:{_vcard_escape(c.company)}")
    if c.phone:
        lines.append(f"TEL;TYPE=CELL:{_vcard_escape(c.phone)}")
    lines += [f"EMAIL;TYPE=INTERNET:{_vcard_escape(e.address)}" for e in c.emails]
    if c.notes:
        lines.append(f"NOTE:{_vcard_escape(c.notes)}")
    lines.append("END:VCARD")
    filename = re.sub(r"[^A-Za-z0-9]+", "-", f"{c.first_name} {c.last_name}").strip("-") or "contact"
    return Response(
        content="\r\n".join(lines) + "\r\n",
        media_type="text/vcard",
        headers={"Content-Disposition": f'attachment; filename="{filename}.vcf"'},
    )


# The frontend. Mounted last so /api routes take priority.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
