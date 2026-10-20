import "./style.css";
import {
  State,
  CheckConnection,
  Signup,
  MyComputer,
  ReportNow,
  UpdateUser,
  ConfirmDetails,
  StartReregistration,
  UnlockITSettings,
  UnlockMode,
  LockITSettings,
  ITSettings,
  SaveServerURL,
  Connection,
  TakePrompt,
  Session,
  Branding,
} from "../wailsjs/go/bound/App";
import { EventsOn } from "../wailsjs/runtime/runtime";

const root = document.getElementById("app");

// ---- tiny helpers ----

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
  return node;
}

function show(...nodes) {
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function message(kind, text) {
  return el("div", { class: `msg ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}

function field(name, label, { value = "", type = "text", required = false, hint = "" } = {}) {
  const input = el("input", { type, name, id: `f-${name}`, value, required, autocomplete: "off", spellcheck: "false" });
  const error = el("span", { class: "field-error", id: `e-${name}` });
  input.setAttribute("aria-describedby", error.id);
  const wrap = el(
    "label",
    { for: input.id },
    el("span", {}, label, required ? " *" : "", required ? "" : el("span", { class: "opt" }, " (optional)")),
    input,
    hint ? el("span", { class: "muted" }, hint) : "",
    error,
  );
  return wrap;
}

function showFieldErrors(form, errors = {}) {
  for (const input of form.querySelectorAll("input")) {
    const msg = errors[input.name] ?? "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    const span = form.querySelector(`#e-${input.name}`);
    if (span) span.textContent = msg;
  }
  const first = form.querySelector('input[aria-invalid="true"]');
  if (first) first.focus();
}

function busy(button, text, on) {
  if (on) {
    button.dataset.label = button.textContent;
    button.replaceChildren(el("span", { class: "spinner" }), text);
  } else {
    button.textContent = button.dataset.label;
  }
  button.disabled = on;
}

function userFields(user) {
  const u = user ?? {};
  return [
    el(
      "div",
      { class: "grid2" },
      field("fullName", "Full name", { value: u.fullName, required: true }),
      field("employeeId", "Employee ID", { value: u.employeeId, required: true }),
    ),
    field("department", "Department", { value: u.department, required: true }),
    el(
      "div",
      { class: "grid2" },
      field("position", "Position", { value: u.position }),
      field("phone", "Phone", { value: u.phone }),
    ),
    field("email", "Email", { value: u.email, type: "email" }),
  ];
}

function readUser(form) {
  const v = (n) => form.elements[n].value;
  return {
    fullName: v("fullName"),
    employeeId: v("employeeId"),
    department: v("department"),
    position: v("position"),
    phone: v("phone"),
    email: v("email"),
    policyAccepted: form.elements.policyAccepted ? form.elements.policyAccepted.checked : false,
  };
}

// ---- screens ----

async function start() {
  const st = await State();
  document.getElementById("version").textContent = `v${st.version}`;
  if (st.screen === "home") {
    await home();
    return checkPrompt();
  }
  if (st.screen === "signup") return signup(st);
  return setup(st);
}

// ---- background connection and IT's "confirm your details" prompt ----

// The connection line next to the title ("Connected", "Offline", ...); updated by Go events.
const connection = el("span", { class: "conn", id: "conn" });
connection.hidden = true;

async function refreshConnection() {
  const c = await Connection();
  connection.hidden = !c.status;
  connection.textContent = c.label;
  connection.dataset.status = c.status;
}

// IT asked the user to confirm their details: open "Update my details" with a message. With IT's
// approval (p.confirm) the user saves once without the PIN and cannot change the employee ID.
async function checkPrompt() {
  const p = await TakePrompt();
  if (!p.show) return;
  const st = await State();
  if (st.screen !== "home") return;
  const h = await MyComputer();
  if (!h.ok) return;
  if (p.confirm) confirmUser(h, p.message);
  else editUser(h, p.message);
}

EventsOn("connection", refreshConnection);
EventsOn("prompt-details", checkPrompt);
refreshConnection();
document.querySelector("header.top").append(connection);

// ---- the agency's name and logo (set on the server's Settings page, saved here for offline starts) ----

const logo = document.getElementById("logo");
const brandName = document.getElementById("brand-name");

// The window title stays "PC_READER"; the header shows the agency name and logo.
async function refreshBranding() {
  const b = await Branding();
  brandName.textContent = b.name;
  logo.hidden = !b.logo;
  if (b.logo) logo.src = b.logo;
  else logo.removeAttribute("src");
}

EventsOn("branding", refreshBranding);
refreshBranding();

// ---- the IT PIN: without it the app is view-only ----

// "Unlocked for IT · Lock" with the minutes left. One correct PIN covers several actions for 10 minutes;
// the window locks again when it is hidden (Go emits "session").
const session = el("span", { class: "session" });
session.hidden = true;
document.querySelector("header.top").append(session);
let sessionLeft = 0;

async function refreshSession() {
  const sv = await Session();
  sessionLeft = sv.unlocked ? sv.secondsLeft : 0;
  drawSession();
}

function drawSession() {
  session.hidden = sessionLeft <= 0;
  if (session.hidden) return;
  const mins = Math.floor(sessionLeft / 60);
  const secs = String(sessionLeft % 60).padStart(2, "0");
  session.replaceChildren(
    `Unlocked for IT (${mins}:${secs}) · `,
    el("button", { class: "link", onclick: lockNow }, "Lock"),
  );
}

async function lockNow() {
  await LockITSettings();
  await refreshSession();
  home();
}

setInterval(() => {
  if (sessionLeft <= 0) return;
  sessionLeft -= 1;
  drawSession();
  if (sessionLeft <= 0) refreshSession();
}, 1000);
EventsOn("session", refreshSession);
refreshSession();

// Asks for the IT PIN in a small dialog. Resolves true once the server accepted it (the session is then
// open), false if cancelled. The server must be reachable: there is no offline fallback for actions.
function pinDialog(why) {
  return new Promise((resolve) => {
    const banner = el("div");
    const form = el("form", { novalidate: true });
    const submit = el("button", { type: "submit", class: "primary" }, "Unlock");
    const close = (ok) => {
      overlay.remove();
      resolve(ok);
    };
    form.append(
      field("pin", "IT PIN", { type: "password", required: true, hint: "6 digits, shown on the PC_READER dashboard. It changes every hour." }),
      el("div", { class: "actions" }, el("button", { type: "button", onclick: () => close(false) }, "Cancel"), submit),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      busy(submit, "Checking…", true);
      const res = await UnlockITSettings(form.elements.pin.value);
      busy(submit, "", false);
      if (res.ok) {
        await refreshSession();
        return close(true);
      }
      form.elements.pin.value = "";
      showFieldErrors(form, {});
      // Mode "key" means the server could not check the PIN; for actions that just means "try again online".
      const text = res.mode === "key" ? "Can't reach the server. Try again when this computer is online." : res.message;
      banner.replaceChildren(message("error", text));
    });
    const overlay = el(
      "div",
      { class: "overlay", role: "dialog", "aria-modal": "true", "aria-label": "IT PIN" },
      el("div", { class: "card dialog" }, el("h2", {}, "IT PIN needed"), el("p", { class: "muted" }, why), banner, form),
    );
    document.body.append(overlay);
    form.elements.pin.focus();
  });
}

// Makes sure the session holds a PIN (asks for it when not); false if the user backed out.
async function ensurePin(why) {
  const sv = await Session();
  return sv.hasPin ? true : pinDialog(why);
}

// The tray's "Report now" while locked: the window opens and asks for the PIN first.
EventsOn("report-needs-pin", async () => {
  const st = await State();
  if (st.screen !== "home") return;
  if (!(await pinDialog("Report now sends this computer's details to IT. IT needs to enter the PIN."))) return;
  const res = await ReportNow();
  refreshSession();
  home(res.ok ? res.message : undefined);
});

function setup(st, errorText) {
  const banner = el("div", {}, errorText ? message("error", errorText) : "");
  const form = el(
    "form",
    { novalidate: true },
    field("serverUrl", "Server address", { value: st.serverUrl, required: true, hint: "For example http://192.168.1.10:3000" }),
    field("key", "Enrollment key", {
      type: "password",
      required: true,
      hint: "Given to you by IT. It is not saved on this computer (only a scrambled copy, so IT can open Settings if the server is down).",
    }),
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, "Check connection and continue")),
  );
  const val = (n) => (form.elements[n] ? form.elements[n].value : "");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    busy(btn, "Checking…", true);
    const res = await CheckConnection(val("serverUrl"), val("key"));
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    banner.replaceChildren(res.ok ? "" : message("error", res.message));
    if (!res.ok) return;
    signup({ ...st, serverUrl: val("serverUrl") });
  });
  show(
    el("h1", {}, "IT setup"),
    el("p", { class: "muted" }, "IT: enter the server address and the enrollment key. The person using this computer signs up next."),
    el("div", { class: "card" }, banner, form),
  );
}

function signup(st) {
  const banner = el("div");
  const form = el(
    "form",
    { novalidate: true },
    ...userFields(st.user),
    el("div", { class: "notice" }, st.notice),
    field("pin", "IT PIN", {
      type: "password",
      required: true,
      hint: "Ask IT for the 6-digit PIN shown on the PC_READER dashboard. It changes every hour.",
    }),
    el(
      "label",
      { class: "check", for: "f-policyAccepted" },
      el("input", { type: "checkbox", name: "policyAccepted", id: "f-policyAccepted" }),
      "I have read the data-use notice and agree.",
    ),
    el("span", { class: "field-error", id: "e-policyAccepted" }),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", onclick: () => setup(st) }, "Back"),
      el("button", { type: "submit", class: "primary" }, "Sign up"),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    busy(btn, "Scanning and registering — this can take up to a minute…", true);
    const res = await Signup(readUser(form), form.elements.pin.value);
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    if (res.ok) {
      refreshSession();
      return home(res.message);
    }
    if (res.needsKey) {
      // The server refused the enrollment key: back to the key field.
      return setup(await State(), res.message);
    }
    banner.replaceChildren(message("error", res.message));
  });
  show(
    el("h1", {}, "Tell us who you are"),
    el("p", { class: "muted" }, "Fields marked * are required. You can change your details later."),
    el("div", { class: "card" }, banner, form),
  );
}

async function home(notice) {
  show(el("p", {}, el("span", { class: "spinner" }), "Reading this computer…"));
  const h = await MyComputer();
  if (!h.ok) {
    return show(message("error", h.message), el("button", { onclick: () => home() }, "Try again"));
  }
  renderHome(h, notice ? message("ok", notice) : "");
}

function dl(rows) {
  return el("dl", {}, rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

function renderHome(h, banner) {
  const s = h.summary;
  const u = h.assignedUser;
  const status = el("div", {}, banner);
  const reportBtn = el("button", { class: "primary" }, "Report now");
  reportBtn.addEventListener("click", async () => {
    if (!(await ensurePin("Report now sends this computer's details to IT. IT needs to enter the PIN."))) return;
    busy(reportBtn, "Scanning and sending…", true);
    let res = await ReportNow();
    if (res.needsPin && (await pinDialog(res.message))) res = await ReportNow(); // the PIN changed: ask once more
    busy(reportBtn, "", false);
    refreshSession();
    if (res.ok) return renderHome(res.home, message("ok", res.message));
    status.replaceChildren(message("error", res.message));
    if (res.needsReregistration) status.append(reregisterButton());
  });

  const disks = s.disks.map((d) =>
    el(
      "div",
      { class: "disk" },
      `${d.name}: ${d.free} free of ${d.size}`,
      d.hasUsage ? el("div", { class: "bar", role: "img", "aria-label": `${d.usedPct}% used` }, el("span", { style: `width:${d.usedPct}%` })) : "",
    ),
  );

  const details = el(
    "details",
    { class: "card" },
    el("summary", {}, "Full details"),
    ...h.sections.map((sec) =>
      el(
        "details",
        {},
        el("summary", {}, sec.title),
        ...sec.entries.map((en) =>
          el("div", { class: "entry" }, en.heading ? el("h3", {}, en.heading) : "", dl(en.fields.map((f) => [f.label, f.value]))),
        ),
      ),
    ),
  );

  show(
    el("h1", {}, "My computer"),
    el("p", { class: "muted" }, "You can look at your computer's details here. Report now, Update my details and Settings need the IT PIN."),
    h.reported ? "" : el("p", { class: "muted" }, "These specs were just read from this computer and have not been sent to IT yet. Press “Report now”."),
    status,
    h.needsReregistration ? el("div", {}, message("error", h.message), reregisterButton()) : "",
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Summary"),
      dl([
        ["Computer name", s.computerName],
        ["Model", s.model],
        ["Serial number", s.serial],
        ["Operating system", s.os],
        ["Processor", s.cpu],
        ["Memory", s.memory],
        ["IP address", s.ipAddress],
        ["Assigned to", u ? `${u.fullName} (${u.employeeId}), ${u.department}` : "Not known on this computer"],
        ["Last report", h.lastReportAt],
      ]),
      el("div", { class: "disks", style: "margin-top:12px" }, ...disks),
    ),
    el("div", { class: "actions", style: "margin-bottom:16px" }, reportBtn, el("button", { onclick: () => editUser(h) }, "Update my details")),
    details,
    el("p", { class: "footer-link" }, el("button", { class: "link", onclick: () => itLogin() }, "Settings")),
  );
}

// Registering again (after the server rejects this computer) goes through the unlock prompt, then to setup.
function reregisterButton() {
  return el("button", { class: "primary", onclick: () => itLogin("reregister") }, "Register this computer again (IT)");
}

// The unlock prompt. It asks for the IT PIN shown on the dashboard (the server checks it); when the server
// cannot answer, or no longer knows this computer, it asks for the enrollment key instead.
async function itLogin(next, startMessage) {
  const sv = await Session();
  if (sv.unlocked) {
    // Already unlocked this session: no second prompt.
    if (next !== "reregister") return itSettings();
    const st = await StartReregistration();
    return st.screen === "setup" ? setup(st) : home();
  }
  await LockITSettings(); // start fresh: the PIN prompt again, even if the last visit fell back to the key
  const prompt = await UnlockMode();
  const banner = el("div");
  const intro = el("p", { class: "muted" });
  const form = el("form", { novalidate: true });
  const submit = el("button", { type: "submit", class: "primary" }, next === "reregister" ? "Continue" : "Open Settings");

  function render(mode, text) {
    intro.textContent = text;
    form.replaceChildren(
      field("pin", mode === "key" ? "Enrollment key" : "IT PIN", {
        type: "password",
        required: true,
        hint: mode === "key" ? "The key IT used to set up PC_READER." : "6 digits. It changes every hour.",
      }),
      el(
        "div",
        { class: "actions" },
        el("button", { type: "button", onclick: async () => { await LockITSettings(); home(); } }, "Cancel"),
        submit,
      ),
    );
    form.dataset.mode = mode;
  }
  render(prompt.mode, startMessage || prompt.message);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.elements.pin;
    busy(submit, "Checking…", true);
    const res = await UnlockITSettings(input.value);
    busy(submit, next === "reregister" ? "Continue" : "Open Settings", false);
    if (res.ok && res.mode === "reregister") {
      // The server rejected this computer: the typed key goes straight to the signup form.
      const st = await State();
      return st.screen === "signup" ? signup(st) : setup(st);
    }
    if (res.ok) {
      refreshSession();
      if (next !== "reregister") return itSettings();
      const st = await StartReregistration();
      return st.screen === "setup" ? setup(st) : home();
    }
    if (res.mode !== form.dataset.mode) {
      // The server could not check the PIN: switch to the enrollment key.
      render(res.mode, res.message);
      banner.replaceChildren();
      return;
    }
    input.value = "";
    showFieldErrors(form, {});
    banner.replaceChildren(message("error", res.message));
  });
  show(el("h1", {}, next === "reregister" ? "Register again" : "Settings"), intro, el("div", { class: "card" }, banner, form));
}

async function itSettings(notice) {
  const cur = await ITSettings();
  if (!cur.ok) return itLogin();
  const leave = async () => {
    // Leaving Settings closes the Settings part only if the key opened it; a PIN session stays for its 10 minutes.
    home();
  };

  const urlBanner = el("div", {}, notice ? message("ok", notice) : "");
  const urlForm = el(
    "form",
    { novalidate: true },
    field("serverUrl", "Server address", { value: cur.serverUrl, required: true, hint: "For example http://192.168.1.10:3000" }),
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, "Check connection and save")),
  );
  urlForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = urlForm.querySelector("button");
    busy(btn, "Checking…", true);
    const res = await SaveServerURL(urlForm.elements.serverUrl.value);
    busy(btn, "", false);
    showFieldErrors(urlForm, res.fieldErrors ?? {});
    urlBanner.replaceChildren(message(res.ok ? "ok" : "error", res.message));
  });

  show(
    el("h1", {}, "Settings"),
    el("div", { class: "card" }, el("h2", {}, "Server address"), urlBanner, urlForm),
    el("div", { class: "actions" }, el("button", { onclick: leave }, "Done")),
  );
}

async function editUser(h, notice) {
  const banner = el("div", {}, notice ? message("ok", notice) : "");
  const sv = await Session();
  const form = el(
    "form",
    { novalidate: true },
    ...userFields(h.assignedUser),
    el("p", { class: "muted" }, "Changing the employee ID moves this computer to that person."),
    // Unlocked with the PIN already? Then no second prompt; otherwise IT types it here.
    sv.hasPin ? "" : field("pin", "IT PIN", { type: "password", required: true, hint: "Shown on the PC_READER dashboard. IT needs to enter it to save." }),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", onclick: () => home() }, "Cancel"),
      el("button", { type: "submit", class: "primary" }, "Save"),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    busy(btn, "Saving…", true);
    const res = await UpdateUser(readUser(form), form.elements.pin ? form.elements.pin.value : "");
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    refreshSession();
    if (res.ok) return home(res.message);
    // The session's PIN was refused (it changed): show the form again with a PIN field.
    if (res.needsPin && !form.elements.pin) return editUser(h, res.message);
    banner.replaceChildren(message("error", res.message));
    if (res.needsReregistration) banner.append(reregisterButton());
  });
  show(el("h1", {}, "Update my details"), el("div", { class: "card" }, banner, form));
}

// The form opened by IT's "Ask user to confirm details": no PIN (IT's approval came with the request),
// one save, and the employee ID stays as it is. If IT is unlocked with the PIN, the normal form is used.
async function confirmUser(h, notice) {
  const sv = await Session();
  if (sv.hasPin) return editUser(h, notice);
  const banner = el("div", {}, message("ok", notice));
  const form = el(
    "form",
    { novalidate: true },
    ...userFields(h.assignedUser),
    el("p", { class: "muted" }, "Changing the employee ID needs IT."),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", onclick: () => home() }, "Cancel"),
      el("button", { type: "submit", class: "primary" }, "Save"),
    ),
  );
  const employeeId = form.elements.employeeId;
  employeeId.readOnly = true;
  employeeId.setAttribute("aria-readonly", "true");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    busy(btn, "Saving…", true);
    const res = await ConfirmDetails(readUser(form));
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    if (res.ok) return home(res.message);
    // The approval was used, expired or refused: from here IT needs to enter the PIN.
    if (res.needsPin) return editUser(h, res.message);
    banner.replaceChildren(message("error", res.message));
    if (res.needsReregistration) banner.append(reregisterButton());
  });
  show(el("h1", {}, "Confirm my details"), el("div", { class: "card" }, banner, form));
}

start();
