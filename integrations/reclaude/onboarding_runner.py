"""Runner that takes a native Relay seat from "an administrator pressed Add" to live.

    onboarding_runner.py CONFIG

It polls the spool written by the console service and drives one session at a time through
fixed steps on three hosts. Every step ends in a verified state and is safe to run again,
so a failure stops the session where it is and an administrator chooses: retry that step,
or abandon and have everything created so far removed.

Rules the runner keeps:
  * The only human action is opening the authorization link. Nothing else waits for input.
  * A model is called twice per seat (worker, then end to end), never repeated automatically.
  * A seat joins the shared groups only after its end-to-end request was billed to it.
  * An exit is used only if it still shows the address the administrator saw when choosing it.
"""
import json
from pathlib import Path
import subprocess
import sys
import time

from onboarding_happy import Happy, StepFailed
from onboarding_store import (CLOSED, EGRESS, NOT_RETRIABLE, SEAT, STEPS, Store, new_session, valid_name, valid_org,
                              write_atomic)

LOGIN_WAIT = 900
OPTIONS_EVERY = 600
# While waiting for the authorization, this many polls in a row may fail to reach the container host.
LOGIN_POLL_GAPS = 20
UNREACHABLE = ("host_timeout", "host_unreachable")
# A failure with one of these codes will not go away by running the step again.
FINAL = ("canary_attempts_exhausted", "authorization_timeout", "login_ended", "seat_is_live", "egress_ip_changed",
         "unknown_egress")
SLOW = {"prepare": 240, "canary": 260, "sub_canary": 330, "native_start": 200, "worker_install": 240, "promote": 200,
        "abandon": 300, "manager_install": 200}


class Cancelled(Exception):
    """The administrator abandoned the session while it was waiting."""


def remote(argv, request, timeout=120):
    """One JSON request to a host agent over its fixed command; one JSON answer back."""
    try:
        done = subprocess.run(argv, input=json.dumps(request), capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise StepFailed("host_timeout", request.get("action")) from None
    except OSError:
        raise StepFailed("host_unreachable", request.get("action")) from None
    try:
        answer = json.loads(done.stdout.strip().splitlines()[-1])
        if not isinstance(answer, dict):
            raise ValueError()
    except (ValueError, IndexError):
        raise StepFailed("host_unreachable", f"{request.get('action')}: exit {done.returncode}") from None
    if answer.get("ok") is not True:
        raise StepFailed(str(answer.get("error") or "host_refused")[:60], answer.get("detail") or "")
    return answer


class Hosts:
    """The three places a seat lives: container host, gateway host (this one), account host."""

    def __init__(self, config):
        self.config = config
        self.happy = Happy(config["happy"], config["root"])

    def nas(self, action, **fields):
        return remote(self.config["nas_command"], {"action": action, **fields}, SLOW.get(action, 120))

    def sub(self, action, **fields):
        return remote(self.config["sub_command"], {"action": action, **fields}, SLOW.get(action, 120))

    def verify_manager(self, config):
        from management import ManagementError, Manager
        try:
            return Manager(config).refresh()
        except ManagementError as error:
            raise StepFailed(error.code) from None


class Runner:
    def __init__(self, store, hosts, sub_control_command, clock=time.time, sleep=time.sleep, login_wait=LOGIN_WAIT):
        self.store, self.hosts, self.sub_control_command = store, hosts, list(sub_control_command)
        self.clock, self.sleep, self.login_wait = clock, sleep, login_wait
        self.options_at = 0

    # ------------------------------------------------------------ loop

    def run_forever(self):
        self.store.prepare()
        settled = False
        while True:
            try:
                if not settled:
                    # Also after an error below: a session must never stay "running" with nobody running it.
                    self.recover()
                    settled = True
                self.tick()
            except Exception as error:  # a full disk or an unreadable file must not end the service
                settled = False
                print(f"onboarding runner: {type(error).__name__} while handling a request", file=sys.stderr, flush=True)
                self.sleep(5)

    def tick(self):
        if self.clock() - self.options_at >= OPTIONS_EVERY:
            self.publish_options()
        request = self.store.take()
        if request is None:
            self.sleep(2)
            return
        self.handle(request)

    def publish_options(self):
        """Exits come from the container host's administrator-maintained list, never from the browser."""
        self.options_at = self.clock()
        try:
            options = self.hosts.nas("options")["options"]
            rows = [{"id": row["id"], "label": row["label"], "expected_ip": row["expected_ip"]}
                    for row in options if EGRESS.fullmatch(str(row.get("id", "")))]
            write_atomic(self.store.root / "options.json", rows)
        except (StepFailed, KeyError, TypeError):
            pass  # keep the last published list; a start re-checks the exit anyway

    def recover(self):
        """After a restart: keep waiting for an authorization, finish a clean-up, stop everything else."""
        for session in self.store.saved():
            if session["status"] == "awaiting_authorization":
                self.advance(session)
            elif session["status"] == "abandoning":
                self.abandon(session)
            elif session["status"] in ("queued", "running"):
                key = next((key for key in STEPS if session["steps"][key]["status"] == "running"), STEPS[0])
                self.fail(session, key, "runner_interrupted", "the runner restarted during this step", key != "prepare")

    def handle(self, request):
        seat, action = request.get("seat"), request.get("action")
        if not isinstance(seat, str) or not SEAT.fullmatch(seat):
            return
        session = self.store.load(seat)
        if action == "start":
            # Checked again here: the spool is written by a less privileged service.
            if (session is not None or not valid_name(request.get("name")) or not valid_org(request.get("org"))
                    or not isinstance(request.get("egress"), str) or not EGRESS.fullmatch(request["egress"])
                    or any(other["status"] not in CLOSED for other in self.store.saved())):
                return
            session = new_session(seat, request["name"], request["egress"], str(request.get("expected_ip"))[:45],
                                  request["org"], self.clock())
            self.advance(session)
        elif session is None or session["status"] in CLOSED:
            return
        elif action == "abandon":
            self.abandon(session)
        elif action == "retry" and session["status"] == "failed" and (session.get("error") or {}).get("retriable"):
            self.advance(session)

    # ------------------------------------------------------------ session

    def fail(self, session, key, code, detail, retriable):
        if key in session["steps"]:
            session["steps"][key].update(status="failed", finished_at=self.clock())
        session.update(status="failed", error={"step": key, "code": code, "detail": str(detail)[:300], "retriable": retriable})
        self.store.save(session)

    def advance(self, session):
        """Run every step that is not done yet, in order, stopping at the first that fails."""
        session.update(status="running", error=None)
        for key in STEPS:
            step = session["steps"][key]
            if step["status"] == "done":
                continue
            # An administrator who abandons a running session is heard before the next step begins.
            if self.abandon_requested(session["seat"]):
                return self.abandon(session)
            step.update(status="running", started_at=self.clock(), finished_at=None)
            self.store.save(session)
            try:
                getattr(self, "step_" + key)(session)
            except Cancelled:
                return self.abandon(session)
            except StepFailed as failure:
                return self.fail(session, key, failure.code, failure.detail,
                                 key not in NOT_RETRIABLE and failure.code not in FINAL)
            except Exception as error:  # reported by type only; the session stays repairable
                return self.fail(session, key, "runner_error", type(error).__name__, key not in NOT_RETRIABLE)
            step.update(status="done", finished_at=self.clock())
            self.store.save(session)
        session.update(status="live", authorization=None)
        self.store.save(session)

    def abandon_requested(self, seat):
        return self.store.take(lambda request: request.get("action") == "abandon" and request.get("seat") == seat) is not None

    def abandon(self, session):
        """Remove the seat from the account host first, so nothing can be scheduled onto what is being torn down."""
        seat = session["seat"]
        session.update(status="abandoning", authorization=None)
        self.store.save(session)
        try:
            self.hosts.sub("abandon", seat=seat)
            self.hosts.happy.abandon(seat)
            self.hosts.nas("abandon", seat=seat)
        except StepFailed as failure:
            return self.fail(session, "abandon", failure.code, failure.detail, False)
        except Exception as error:
            return self.fail(session, "abandon", "runner_error", type(error).__name__, False)
        session.update(status="abandoned", error=None)
        self.store.save(session)

    # ------------------------------------------------------------ steps

    def step_preflight(self, session):
        check = self.hosts.nas("selfcheck")
        if not check.get("passed"):
            failing = sorted(name for name, passed in check.get("checks", {}).items() if not passed)
            raise StepFailed("container_host_not_ready", ", ".join(failing))
        options = self.hosts.nas("options")["options"]
        if not any(row["id"] == session["egress"] and row["expected_ip"] == session["expected_ip"] for row in options):
            raise StepFailed("egress_ip_changed", "the chosen exit no longer shows the address that was confirmed")
        self.hosts.sub("preflight")
        self.hosts.happy.preflight()

    def step_prepare(self, session):
        answer = self.hosts.nas("prepare", seat=session["seat"], egress=session["egress"], expected_ip=session["expected_ip"])
        session["facts"].update(nas_port=answer["allocation"]["port"])

    def step_exit_check(self, session):
        self.hosts.nas("prelogin", seat=session["seat"])

    def step_login(self, session):
        """Start the device login once, show its link, and wait for the administrator to approve it."""
        seat, facts = session["seat"], session["facts"]
        self.hosts.nas("login_start", seat=seat, org=session["org"])
        deadline = facts.setdefault("login_deadline", self.clock() + self.login_wait)
        ended = unreachable = 0
        while True:
            try:
                status = self.hosts.nas("login_status", seat=seat)
                unreachable = 0
            except StepFailed as failure:
                # The login runs on the container host whether or not this poll reached it. A short
                # network gap must not cost the administrator the one authorization the seat gets.
                unreachable += 1
                if failure.code not in UNREACHABLE or unreachable > LOGIN_POLL_GAPS or self.clock() >= deadline:
                    raise
                self.sleep(3)
                continue
            if status.get("bound"):
                session["authorization"] = None
                session["status"] = "running"
                return
            if not status.get("guard_ok"):
                raise StepFailed("exit_guard_not_ready", "the exit changed while waiting for authorization")
            link = status.get("url")
            shown = session["status"] == "awaiting_authorization" and (session.get("authorization") or {}).get("url") == link
            if link and not shown:
                session.update(status="awaiting_authorization", authorization={"url": link, "expires_at": deadline})
                self.store.save(session)
            if not status.get("running"):
                # The login command may exit a moment before its files appear: look twice more.
                ended += 1
                if ended >= 3:
                    raise StepFailed("login_ended", ", ".join(status.get("problems") or []) or "the login ended without a device")
            if self.clock() >= deadline:
                raise StepFailed("authorization_timeout", "the link was not approved in time")
            if self.abandon_requested(seat):
                raise Cancelled()
            self.sleep(3)

    def step_native(self, session):
        answer = self.hosts.nas("native_start", seat=session["seat"])
        if answer.get("org") != session["org"]:
            raise StepFailed("org_mismatch")
        session["facts"]["binding"] = answer["binding"]
        session["result"]["binding"] = answer["binding"]

    def step_worker(self, session):
        self.hosts.nas("worker_install", seat=session["seat"])
        self.hosts.nas("ingress_install", seat=session["seat"])

    def step_native_canary(self, session):
        self.hosts.nas("canary", seat=session["seat"])

    def step_gateway(self, session):
        facts = session["facts"]
        worker_key = self.hosts.nas("relay_key", seat=session["seat"])["relay_key"]
        answer = self.hosts.happy.gateway(session["seat"], facts["binding"], facts["nas_port"], worker_key)
        facts["ledger_account"] = answer["ledger_account"]

    def step_route(self, session):
        # Closed to the public name before the private route exists.
        self.hosts.sub("block_public", seat=session["seat"])
        self.hosts.happy.route(session["seat"])

    def step_sub(self, session):
        seat, facts = session["seat"], session["facts"]
        client_key = self.hosts.happy.paths(seat)["client_key"].read_text().strip()
        answer = self.hosts.sub("sub_create", seat=seat, name=session["name"], client_key=client_key,
                                binding=facts["binding"], org=session["org"], expected_ip=session["expected_ip"])
        facts["sub_account"] = answer["account_id"]
        session["result"]["sub_account"] = answer["account_id"]

    def step_sub_canary(self, session):
        self.hosts.happy.open_gates(session["seat"])
        self.hosts.sub("sub_canary", seat=session["seat"])

    def step_manager(self, session):
        seat, facts = session["seat"], session["facts"]
        answer = self.hosts.nas("manager_install", seat=seat)
        if answer.get("binding") != facts["binding"]:
            raise StepFailed("binding_changed")
        details = {"binding": facts["binding"], "sub_account": facts["sub_account"], "ledger_account": facts["ledger_account"],
                   "expected_ip": session["expected_ip"], "nas_agent": answer["agent"], "nas_config": answer["config"],
                   "guard_file": answer["guard_file"], "guard_revision": answer["guard_revision"]}
        published = self.hosts.happy.manager(seat, session["name"], details, self.sub_control_command, self.hosts.verify_manager)
        session["result"]["relay_id"] = published["relay_id"]

    def step_promote(self, session):
        self.hosts.sub("promote", seat=session["seat"])

    def step_live(self, session):
        seat = session["seat"]
        self.hosts.nas("mark_live", seat=seat)
        self.hosts.sub("mark_live", seat=seat)
        self.hosts.happy.mark_live(seat)


def main(config_path):
    config = json.loads(Path(config_path).read_text())
    for folder in ("seats", "manager-configs", "manager-state", "nginx-backups"):
        (Path(config["root"]) / folder).mkdir(mode=0o700, parents=True, exist_ok=True)
    runner = Runner(Store(config["root"]), Hosts(config), config["sub_control_command"],
                    login_wait=config.get("login_wait_seconds", LOGIN_WAIT))
    runner.run_forever()


if __name__ == "__main__":
    import os
    os.umask(0o077)
    sys.exit(main(sys.argv[1]))
