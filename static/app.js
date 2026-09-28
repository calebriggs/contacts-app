"use strict"; //strict mode which makes some silent mistakes throw errors 

/* ==========================================================================
   Contacts: vanilla JS frontend
   URL Routes (hash based, so links refresh and the Back button all work):
     #/contacts/:id   view/edit a contact
     #/new            create a contact
     (empty)          nothing selected
   ========================================================================== */

const MAX_EMAILS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;                     //format
const PHONE_CHARS_RE = /^\+?[0-9()\-.\s]+((x|ext\.?)\s*[0-9]{1,6})?$/i; //allowed chars
const PHONE_EXT_RE = /(x|ext\.?)\s*[0-9]{1,6}$/i;                       //optional ext
const PHONE_DIGITS = [7, 15]; // 15 is the E.164 maximum for international numbers
const FIELD_ORDER = ["first_name", "last_name", "emails", "phone", "company", "notes"];
const ICONS = { 
  minus: '<svg viewBox="0 0 24 24"><path d="M7 12h10"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
};

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"),
  search: $("search"),
  list: $("contact-list"),
  count: $("contact-count"),
  newContact: $("new-contact"),
  empty: $("empty-state"),
  emptyNew: $("empty-new"),
  form: $("contact-form"),
  heading: $("form-heading"),
  back: $("back"),
  favorite: $("favorite"),
  vcard: $("vcard"),
  first_name: $("first_name"),
  last_name: $("last_name"),
  phone: $("phone"),
  company: $("company"),
  notes: $("notes"),
  emailList: $("email-list"),
  newEmailRow: $("new-email-row"),
  newEmail: $("new-email"),
  confirmEmail: $("confirm-email"),
  addEmail: $("add-email"),
  meta: $("meta"),
  delete: $("delete"),
  cancel: $("cancel"),
  save: $("save"),
  dirtyHint: $("dirty-hint"),
  modal: $("modal"),
  modalTitle: $("modal-title"),
  modalBody: $("modal-body"),
  modalCancel: $("modal-cancel"),
  modalConfirm: $("modal-confirm"),
  toasts: $("toasts"),
};

const state = {
  contacts: [],      // list summaries from the server, in display order
  query: "",
  mode: "empty",     // "empty" | "edit" | "new"
  contact: null,     // the saved contact being edited (null while creating)
  emails: [],        // working copy of the contact's emails
  favorite: false,
  baseline: "",      // snapshot at load time, used to detect unsaved changes
  currentHash: "",
  returnHash: "",    // where Cancel goes after "New contact"
  saving: false,
};

/* ----------------------------- API ----------------------------- */

const api = {
  async request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      });
    } catch {
      throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 });
    }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = typeof body?.detail === "string" ? body.detail : `Something went wrong (${res.status}).`;
      throw Object.assign(new Error(message), { status: res.status, fields: body?.errors || {} });
    }
    return body;
  },
  list: (q) => api.request(`api/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  get: (id) => api.request(`api/contacts/${id}`),
  create: (data) => api.request("api/contacts", { method: "POST", body: JSON.stringify(data) }),
  update: (id, data) => api.request(`api/contacts/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  remove: (id) => api.request(`api/contacts/${id}`, { method: "DELETE" }),
};

/* ---------------------------- helpers ---------------------------- */

const fullName = (c) => `${c.first_name} ${c.last_name}`.trim();
const isWide = () => window.matchMedia("(min-width: 761px)").matches;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// Wrap the parts of `text` that match the search in <mark>, escaping everything.
function highlight(text) {
  const terms = state.query.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return escapeHtml(text);
  return text
    .split(new RegExp(`(${terms.join("|")})`, "gi"))
    .map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join("");
}

// SQLite hands back timestamps without a timezone; they are UTC.
function parseDate(value) {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  el.toasts.append(node);
  setTimeout(() => node.remove(), type === "error" ? 5000 : 3000);
}

function confirmDialog({ title, body, confirmText, cancelText = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement;
    el.modalTitle.textContent = title;
    el.modalBody.textContent = body;
    el.modalConfirm.textContent = confirmText;
    el.modalCancel.textContent = cancelText;
    el.modalConfirm.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    el.modal.hidden = false;
    // For destructive actions the safe choice gets focus, so a stray Enter can't destroy data.
    (danger ? el.modalCancel : el.modalConfirm).focus();

    const close = (result) => {
      el.modal.hidden = true;
      document.removeEventListener("keydown", onKey, true);
      el.modalConfirm.removeEventListener("click", onConfirm);
      el.modalCancel.removeEventListener("click", onCancel);
      el.modal.removeEventListener("mousedown", onBackdrop);
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
      resolve(result);
    };
    const onConfirm = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === el.modal) close(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      if (e.key === "Tab") { // keep focus inside the dialog
        e.preventDefault();
        (document.activeElement === el.modalConfirm ? el.modalCancel : el.modalConfirm).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    el.modalConfirm.addEventListener("click", onConfirm);
    el.modalCancel.addEventListener("click", onCancel);
    el.modal.addEventListener("mousedown", onBackdrop);
  });
}

/* ----------------------------- list ----------------------------- */

let listRequestId = 0;

async function loadList() {
  const requestId = ++listRequestId;
  try {
    const contacts = await api.list(state.query);
    if (requestId !== listRequestId) return; // a newer search already started
    // Favorites are pinned to the top when not searching.
    state.contacts = state.query ? contacts : [...contacts.filter((c) => c.favorite), ...contacts.filter((c) => !c.favorite)];
    renderList();
  } catch (err) {
    if (requestId === listRequestId) toast(err.message, "error");
  }
}

function sectionFor(contact) {
  return !state.query && contact.favorite ? "Favorites" : null;
}

function renderList() {
  const { contacts, query } = state;
  const fragment = document.createDocumentFragment();

  if (!contacts.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    if (query) {
      empty.innerHTML = `No contacts match “${escapeHtml(query)}”.`;
    } else {
      empty.textContent = "No contacts yet.";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-small btn-primary";
      button.textContent = "Add your first contact";
      button.addEventListener("click", () => go("#/new"));
      empty.append(document.createElement("br"), button);
    }
    fragment.append(empty);
  }

  let section = null;
  for (const contact of contacts) {
    const next = query ? null : sectionFor(contact);
    if (next && next !== section) {
      section = next;
      const header = document.createElement("div");
      header.className = "list-section";
      header.textContent = section;
      fragment.append(header);
    }
    const link = document.createElement("a");
    link.className = "contact-link";
    link.href = `#/contacts/${contact.id}`;
    link.title = [fullName(contact), contact.company, contact.email].filter(Boolean).join(" · ");
    if (state.mode === "edit" && state.contact?.id === contact.id) link.classList.add("is-selected");
    link.innerHTML = `<span class="name">${highlight(fullName(contact))}</span>${contact.favorite ? `<span class="star">${ICONS.star}</span>` : ""}`;
    fragment.append(link);
  }

  el.list.replaceChildren(fragment);
  const n = contacts.length;
  el.count.textContent = query ? `${n} ${n === 1 ? "match" : "matches"}` : `${n} ${n === 1 ? "contact" : "contacts"}`;
}

function scrollSelectedIntoView() {
  el.list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
}

/* ----------------------------- form ----------------------------- */

function snapshot() {
  return {
    first_name: el.first_name.value.trim(),
    last_name: el.last_name.value.trim(),
    emails: [...state.emails],
    phone: el.phone.value.trim(),
    company: el.company.value.trim(),
    notes: el.notes.value.trim(),
    favorite: state.favorite,
    pending: el.newEmail.value.trim(), // a half-typed email counts as a change
  };
}

const isDirty = () => state.mode !== "empty" && JSON.stringify(snapshot()) !== state.baseline;

function updateDirty() {
  const dirty = isDirty();
  el.save.disabled = state.saving || (state.mode === "edit" && !dirty);
  el.cancel.disabled = state.mode === "edit" && !dirty;
  el.dirtyHint.hidden = !(dirty && state.mode === "edit");
}

function setFavorite(on) {
  state.favorite = on;
  el.favorite.classList.toggle("is-on", on);
  el.favorite.querySelector("span").textContent = on ? "Favorited" : "Favorite";
}

function fillForm(contact) {
  const c = contact || { first_name: "", last_name: "", phone: "", company: "", notes: "", favorite: false, emails: [] };
  state.contact = contact;
  state.mode = contact ? "edit" : "new";
  el.first_name.value = c.first_name;
  el.last_name.value = c.last_name;
  el.phone.value = c.phone || "";
  el.company.value = c.company || "";
  el.notes.value = c.notes || "";
  setFavorite(c.favorite);
  state.emails = [...c.emails];
  el.newEmail.value = "";
  el.newEmailRow.hidden = true;
  clearErrors();
  renderEmails();

  el.heading.textContent = contact ? "" : "New contact";
  el.delete.hidden = !contact;
  el.vcard.hidden = !contact;
  if (contact) {
    el.vcard.href = `api/contacts/${contact.id}/vcard`;
    const created = parseDate(contact.created_at);
    const updated = parseDate(contact.updated_at);
    el.meta.textContent = `Added ${dateFmt.format(created)}` +
      (updated - created > 60_000 ? ` · Last updated ${dateTimeFmt.format(updated)}` : "");
  } else {
    el.meta.textContent = "";
  }

  el.empty.hidden = true;
  el.form.hidden = false;
  el.app.classList.add("show-detail");
  document.title = contact ? `${fullName(contact)} · Contacts` : "New contact · Contacts";
  state.baseline = JSON.stringify(snapshot());
  updateDirty();
}

function showEmpty() {
  state.mode = "empty";
  state.contact = null;
  el.form.hidden = true;
  el.empty.hidden = false;
  el.app.classList.remove("show-detail");
  document.title = "Contacts";
}

/* ---------------------------- errors ---------------------------- */

function showError(field, message, input = el[field]) {
  const node = el.form.querySelector(`[data-error-for="${field}"]`);
  if (node) node.textContent = message;
  input?.classList.add("invalid");
}

function clearError(field) {
  const node = el.form.querySelector(`[data-error-for="${field}"]`);
  if (node) node.textContent = "";
  if (field === "emails") {
    el.form.querySelectorAll("#new-email, .email-edit").forEach((n) => n.classList.remove("invalid"));
  } else {
    el[field]?.classList.remove("invalid");
  }
}

function clearErrors() {
  el.form.querySelectorAll("[data-error-for]").forEach((n) => { n.textContent = ""; });
  el.form.querySelectorAll(".invalid").forEach((n) => n.classList.remove("invalid"));
}

function showErrors(errors) {
  for (const [field, message] of Object.entries(errors)) {
    showError(field, message, field === "emails" && !el.newEmailRow.hidden ? el.newEmail : el[field]);
  }
  const first = FIELD_ORDER.find((f) => errors[f]);
  if (first === "emails") (el.newEmailRow.hidden ? el.addEmail : el.newEmail).focus();
  else if (first) el[first].focus();
}

// Characters and length are checked separately, so the message says what is actually wrong.
function phoneError(phone) {
  if (!PHONE_CHARS_RE.test(phone)) return "Phone can only contain digits, spaces and + ( ) - .";
  const digits = phone.replace(PHONE_EXT_RE, "").replace(/\D/g, "").length; // extension not counted
  const [min, max] = PHONE_DIGITS;
  if (digits < min || digits > max) return `Phone number must have between ${min} and ${max} digits`;
  return null;
}

function validate(data) {
  const errors = {};
  if (!data.first_name) errors.first_name = "First name is required";
  if (!data.last_name) errors.last_name = "Last name is required";
  const phone = data.phone && phoneError(data.phone);
  if (phone) errors.phone = phone;
  const badEmail = data.emails.find((e) => !EMAIL_RE.test(e));
  if (badEmail) errors.emails = `“${badEmail}” doesn't look like a valid email address`;
  return errors;
}

/* ---------------------------- emails ---------------------------- */

function emailError(address, ignoreIndex = -1) {
  if (!EMAIL_RE.test(address)) return `“${address}” doesn't look like a valid email address`;
  const duplicate = state.emails.some((e, i) => i !== ignoreIndex && e.toLowerCase() === address.toLowerCase());
  if (duplicate) return `${address} is already on this contact`;
  return null;
}

function renderEmails() {
  const items = state.emails.map((address, index) => {
    const li = document.createElement("li");
    li.className = "email-item";

    const text = document.createElement("button");
    text.type = "button";
    text.className = "email-address";
    text.textContent = address;
    text.title = "Click to edit";
    text.addEventListener("click", () => editEmail(li, index));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.tabIndex = -1; // mouse-only, per the Figma hover design
    remove.className = "remove-email";
    remove.title = "Remove email";
    remove.innerHTML = ICONS.minus;
    remove.addEventListener("click", () => removeEmail(index));

    li.append(text, remove);
    return li;
  });
  el.emailList.replaceChildren(...items);
  el.addEmail.hidden = !el.newEmailRow.hidden || state.emails.length >= MAX_EMAILS;
}

function removeEmail(index) {
  state.emails.splice(index, 1);
  clearError("emails");
  renderEmails();
  updateDirty();
  // Keep keyboard focus somewhere sensible instead of dropping it on <body>.
  const buttons = el.emailList.querySelectorAll(".remove-email");
  (buttons[index] || buttons[index - 1] || el.addEmail).focus();
}

// Clicking an address turns it into an input so typos can be fixed in place.
function editEmail(li, index) {
  const original = state.emails[index];
  const input = document.createElement("input");
  input.type = "email";
  input.className = "email-edit";
  input.value = original;
  input.maxLength = 254;
  li.replaceChildren(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (commit) => {
    if (finished) return true;
    const value = input.value.trim();
    if (commit && value && value !== original) {
      const error = emailError(value, index);
      if (error) {
        showError("emails", error, input);
        return false;
      }
      state.emails[index] = value;
    } else if (commit && !value) {
      state.emails.splice(index, 1); // clearing the text removes the email
    }
    finished = true;
    clearError("emails");
    renderEmails();
    updateDirty();
    return true;
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (finish(true)) el.emailList.children[index]?.querySelector(".email-address")?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("input", () => { clearError("emails"); updateDirty(); });
}

// Figma note: clicking "add email" shows an input for a new address.
function openNewEmail() {
  el.newEmailRow.hidden = false;
  el.addEmail.hidden = true;
  el.newEmail.focus();
}

function closeNewEmail({ focus = false } = {}) {
  el.newEmail.value = "";
  el.newEmailRow.hidden = true;
  clearError("emails");
  renderEmails();
  updateDirty();
  if (focus) el.addEmail.focus();
}

// Adds whatever is typed in the new-email box. Returns false if it's invalid.
function commitNewEmail() {
  const value = el.newEmail.value.trim();
  if (!value) return true;
  if (state.emails.length >= MAX_EMAILS) {
    showError("emails", `A contact can have at most ${MAX_EMAILS} emails`, el.newEmail);
    return false;
  }
  const error = emailError(value);
  if (error) {
    showError("emails", error, el.newEmail);
    return false;
  }
  state.emails.push(value);
  el.newEmail.value = "";
  clearError("emails");
  renderEmails();
  updateDirty();
  return true;
}

/* ------------------------ save / delete / cancel ------------------------ */

async function save() {
  if (state.saving || state.mode === "empty") return;
  if (state.mode === "edit" && !isDirty()) return;

  // Finish any email edit in progress, and include a typed-but-not-added email:
  // people often type an address and hit Save without pressing Enter first.
  const inlineEdit = el.emailList.querySelector(".email-edit");
  if (inlineEdit) {
    inlineEdit.blur();
    if (el.emailList.querySelector(".email-edit")) return inlineEdit.focus();
  }
  if (!commitNewEmail()) return el.newEmail.focus();
  if (!el.newEmailRow.hidden) closeNewEmail();

  clearErrors();
  const { pending, ...data } = snapshot();
  const errors = validate(data);
  if (Object.keys(errors).length) return showErrors(errors);

  const isNew = state.mode === "new";
  setSaving(true);
  try {
    const saved = isNew ? await api.create(data) : await api.update(state.contact.id, data);
    fillForm(saved);
    if (isNew) {
      // Replace #/new so Back doesn't return to an empty form.
      state.currentHash = `#/contacts/${saved.id}`;
      history.replaceState(null, "", state.currentHash);
      state.query = el.search.value = ""; // make sure the new contact is visible in the list
    }
    toast(isNew ? `${fullName(saved)} added` : "Changes saved");
    await loadList();
    scrollSelectedIntoView();
  } catch (err) {
    if (err.status === 404) {
      toast("This contact was deleted in another window.", "error");
      state.baseline = JSON.stringify(snapshot());
      go("", { replace: true });
      loadList();
    } else if (err.fields && Object.keys(err.fields).length) {
      const fields = {};
      for (const [key, message] of Object.entries(err.fields)) {
        const field = key.split(".")[0];
        if (!fields[field]) fields[field] = message;
      }
      showErrors(fields);
    } else {
      toast(err.message, "error");
    }
  } finally {
    setSaving(false);
  }
}

function setSaving(saving) {
  state.saving = saving;
  el.save.classList.toggle("is-busy", saving);
  updateDirty();
}

async function deleteContact() {
  const contact = state.contact;
  if (!contact) return;
  const ok = await confirmDialog({
    title: `Delete ${fullName(contact)}?`,
    body: "This contact and all of their email addresses will be permanently removed.",
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return;

  try {
    await api.remove(contact.id);
  } catch (err) {
    if (err.status !== 404) return toast(err.message, "error"); // 404: already gone, carry on
  }

  // Select the neighbour, like a mail client does, so the user can keep going.
  const index = state.contacts.findIndex((c) => c.id === contact.id);
  const neighbour = state.contacts[index + 1] || state.contacts[index - 1];
  showEmpty(); // no unsaved-changes prompt for a contact that no longer exists
  toast(`${fullName(contact)} deleted`);
  await loadList();
  go(neighbour && isWide() ? `#/contacts/${neighbour.id}` : "", { replace: true });
}

function cancel() {
  if (state.mode === "new") {
    showEmpty();
    go(isWide() ? state.returnHash : "", { replace: true });
  } else if (state.contact) {
    fillForm(state.contact); // throw away edits
  }
}

/* ---------------------------- routing ---------------------------- */

function go(hash, { replace = false } = {}) {
  const url = hash || location.pathname + location.search;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  route();
}

async function route() {
  const hash = location.hash === "#" ? "" : location.hash;
  if (hash === state.currentHash) {
    if (hash === "#/new") el.first_name.focus();
    return;
  }

  if (isDirty()) {
    const name = state.contact ? fullName(state.contact) : "this new contact";
    const discard = await confirmDialog({
      title: "Discard unsaved changes?",
      body: `You've made changes to ${name} that haven't been saved.`,
      confirmText: "Discard",
      cancelText: "Keep editing",
      danger: true,
    });
    if (!discard) {
      history.replaceState(null, "", state.currentHash || location.pathname + location.search);
      return;
    }
  }

  const previous = state.currentHash;
  state.currentHash = hash;
  const match = hash.match(/^#\/contacts\/(\d+)$/);

  if (hash === "#/new") {
    state.returnHash = previous.startsWith("#/contacts/") ? previous : "";
    fillForm(null);
    el.first_name.focus();
  } else if (match) {
    await openContact(Number(match[1]));
  } else {
    showEmpty();
  }
  renderList();
  scrollSelectedIntoView();
}

async function openContact(id) {
  try {
    const contact = await api.get(id);
    if (state.currentHash !== `#/contacts/${id}`) return; // user already moved on
    fillForm(contact);
  } catch (err) {
    if (state.currentHash !== `#/contacts/${id}`) return;
    toast(err.status === 404 ? "That contact doesn't exist anymore." : err.message, "error");
    showEmpty();
    history.replaceState(null, "", location.pathname + location.search);
    state.currentHash = "";
    if (err.status === 404) loadList();
  }
}

/* ----------------------------- events ----------------------------- */

function bindEvents() {
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  el.newContact.addEventListener("click", () => go("#/new"));
  el.emptyNew.addEventListener("click", () => go("#/new"));
  el.back.addEventListener("click", () => go(""));

  // Search (debounced, results come from the server so emails/company match too).
  let timer;
  el.search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = el.search.value.trim();
      loadList();
    }, 150);
  });
  el.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.search.value) {
      e.preventDefault();
      el.search.value = "";
      state.query = "";
      loadList();
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      const first = el.list.querySelector(".contact-link");
      if (!first) return;
      e.preventDefault();
      if (e.key === "Enter") first.click();
      else first.focus();
    }
  });
  // Arrow keys move through the list.
  el.list.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("contact-link") || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const links = [...el.list.querySelectorAll(".contact-link")];
    const next = links[links.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
    else if (e.key === "ArrowUp") el.search.focus();
  });

  // Form
  el.form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  el.form.addEventListener("input", (e) => {
    if (e.target.name) clearError(e.target.name);
    updateDirty();
  });
  el.favorite.addEventListener("click", () => { setFavorite(!state.favorite); updateDirty(); });
  el.delete.addEventListener("click", deleteContact);
  el.cancel.addEventListener("click", cancel);

  // Emails
  el.addEmail.addEventListener("click", openNewEmail);
  el.confirmEmail.addEventListener("click", () => { commitNewEmail(); el.newEmail.focus(); });
  el.newEmail.addEventListener("input", () => clearError("emails"));
  el.newEmail.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // don't submit the whole form
      if (!el.newEmail.value.trim()) closeNewEmail({ focus: true });
      else commitNewEmail(); // stay open so several emails can be added in a row
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeNewEmail({ focus: true });
    }
  });
  el.newEmail.addEventListener("blur", (e) => {
    // Close the empty box when the user clicks away (but not when clicking "Add").
    if (!el.newEmail.value.trim() && e.relatedTarget !== el.confirmEmail) closeNewEmail();
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (!el.modal.hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault(); // never show the browser's "Save page" dialog
      save();
      return;
    }
    if (mod || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "/") {
      e.preventDefault();
      el.search.focus();
      el.search.select();
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      go("#/new");
    } else if (e.key === "Escape" && state.mode === "edit" && isDirty()) {
      cancel();
    }
  });
}

/* ------------------------------ start ------------------------------ */

async function init() {
  bindEvents();
  await loadList();
  // On a wide screen, open the first contact instead of showing a blank pane.
  if (!location.hash && isWide() && state.contacts.length) {
    history.replaceState(null, "", `#/contacts/${state.contacts[0].id}`);
  }
  await route();
}

init();
