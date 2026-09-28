"""API tests for the Contacts app.

Runs against a running server using only the Python standard library:

    python3 test_api.py                                          # local server (http://localhost:8000)
    python3 test_api.py https://contacts-app-riggs.onrender.com  # live site

Every test deletes the contacts it creates, so it is safe to run against real data.
"""

import json
import os
import sys
import unittest
import urllib.error
import urllib.request
import uuid

BASE_URL = os.environ.get("API_URL", "http://localhost:8000")


def request(method, path, body=None):
    """Send a request and return (status_code, parsed_body)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE_URL + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:  # long timeout: Render may be waking up
            return res.status, _parse(res.read())
    except urllib.error.HTTPError as err:
        return err.code, _parse(err.read())


def _parse(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode()


class ContactsApiTest(unittest.TestCase):
    def setUp(self):
        # A unique tag keeps test contacts from clashing with real ones.
        self.tag = "Test" + uuid.uuid4().hex[:8]
        self.created = []

    def tearDown(self):
        for contact_id in self.created:
            request("DELETE", f"/api/contacts/{contact_id}")

    def create(self, **fields):
        payload = {"first_name": "Test", "last_name": self.tag, "emails": []}
        payload.update(fields)
        status, body = request("POST", "/api/contacts", payload)
        if status == 201:
            self.created.append(body["id"])
        return status, body

    # ---- create / read ----

    def test_list_contacts(self):
        status, body = request("GET", "/api/contacts")
        self.assertEqual(status, 200)
        self.assertIsInstance(body, list)

    def test_create_and_get(self):
        status, body = self.create(emails=["a@example.com", "b@example.org"], company="Acme", favorite=True)
        self.assertEqual(status, 201)
        self.assertEqual(body["last_name"], self.tag)
        self.assertEqual(body["emails"], ["a@example.com", "b@example.org"])
        self.assertEqual(body["company"], "Acme")
        self.assertTrue(body["favorite"])

        status, fetched = request("GET", f"/api/contacts/{body['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(fetched["emails"], ["a@example.com", "b@example.org"])

    def test_whitespace_is_trimmed(self):
        status, body = self.create(first_name="  Ann  ", company="   ")
        self.assertEqual(status, 201)
        self.assertEqual(body["first_name"], "Ann")
        self.assertIsNone(body["company"])

    # ---- validation ----

    def test_first_and_last_name_required(self):
        status, body = request("POST", "/api/contacts", {"first_name": "", "last_name": "   "})
        self.assertEqual(status, 422)
        self.assertEqual(body["errors"]["first_name"], "First name is required")
        self.assertEqual(body["errors"]["last_name"], "Last name is required")

    def test_missing_names(self):
        status, body = request("POST", "/api/contacts", {})
        self.assertEqual(status, 422)
        self.assertIn("first_name", body["errors"])
        self.assertIn("last_name", body["errors"])

    def test_invalid_email(self):
        status, body = self.create(emails=["good@example.com", "nope@"])
        self.assertEqual(status, 422)
        self.assertIn("emails.1", body["errors"])

    def test_duplicate_email(self):
        status, body = self.create(emails=["a@example.com", "A@EXAMPLE.com"])
        self.assertEqual(status, 422)
        self.assertIn("emails", body["errors"])

    def test_too_many_emails(self):
        status, _ = self.create(emails=[f"user{i}@example.com" for i in range(21)])
        self.assertEqual(status, 422)

    def test_invalid_phone_characters(self):
        status, body = self.create(phone="call me")
        self.assertEqual(status, 422)
        self.assertIn("only contain", body["errors"]["phone"])

    def test_phone_digit_count(self):
        status, body = self.create(phone="123456")
        self.assertEqual(status, 422)
        self.assertIn("between 7 and 15 digits", body["errors"]["phone"])

        status, body = self.create(phone="+1 (555) 010-2030 ext 12")
        self.assertEqual(status, 201)

    # ---- update ----

    def test_update(self):
        _, contact = self.create(emails=["a@example.com", "b@example.com"])
        payload = {"first_name": "Test", "last_name": self.tag + "x", "emails": ["c@example.com", "a@example.com"]}
        status, body = request("PUT", f"/api/contacts/{contact['id']}", payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["last_name"], self.tag + "x")
        self.assertEqual(body["emails"], ["c@example.com", "a@example.com"])

        _, fetched = request("GET", f"/api/contacts/{contact['id']}")
        self.assertEqual(fetched["emails"], ["c@example.com", "a@example.com"])

    def test_update_validation(self):
        _, contact = self.create()
        status, _ = request("PUT", f"/api/contacts/{contact['id']}", {"first_name": "", "last_name": "x"})
        self.assertEqual(status, 422)

    # ---- search ----

    def test_search(self):
        _, contact = self.create(emails=[f"{self.tag.lower()}@example.com"])

        status, results = request("GET", f"/api/contacts?q={self.tag}")
        self.assertEqual(status, 200)
        self.assertEqual([c["id"] for c in results], [contact["id"]])

        _, results = request("GET", f"/api/contacts?q=Test%20{self.tag}")  # every word must match
        self.assertEqual([c["id"] for c in results], [contact["id"]])

        _, results = request("GET", f"/api/contacts?q={self.tag.lower()}%40example")  # matches email
        self.assertEqual([c["id"] for c in results], [contact["id"]])

    def test_search_treats_wildcards_literally(self):
        self.create()
        _, results = request("GET", f"/api/contacts?q=%25{self.tag}")  # "%Test1234..."
        self.assertEqual(results, [])

    # ---- delete ----

    def test_delete(self):
        _, contact = self.create()
        status, _ = request("DELETE", f"/api/contacts/{contact['id']}")
        self.assertEqual(status, 204)
        status, _ = request("GET", f"/api/contacts/{contact['id']}")
        self.assertEqual(status, 404)
        status, _ = request("DELETE", f"/api/contacts/{contact['id']}")
        self.assertEqual(status, 404)

    def test_unknown_contact_returns_404(self):
        status, _ = request("GET", "/api/contacts/999999999")
        self.assertEqual(status, 404)

    # ---- extras ----

    def test_vcard_export(self):
        _, contact = self.create(emails=["v@example.com"])
        status, body = request("GET", f"/api/contacts/{contact['id']}/vcard")
        self.assertEqual(status, 200)
        self.assertIn("BEGIN:VCARD", body)
        self.assertIn("EMAIL;TYPE=INTERNET:v@example.com", body)

    def test_frontend_is_served(self):
        status, body = request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("<title>Contacts</title>", body)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        BASE_URL = sys.argv.pop(1).split("#")[0].rstrip("/")
    print(f"Testing {BASE_URL}\n")
    try:
        request("GET", "/api/contacts")
    except urllib.error.URLError as err:
        sys.exit(f"Can't reach {BASE_URL} ({err.reason}). Is the server running?")
    unittest.main(verbosity=2)
