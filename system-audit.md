# System Audit – kali (2026-10-10)

Scope: read-only audit run as unprivileged user `kali`. Checks needing root were not done: firewall rules, process names for some listeners, `lastb`, and the contents of `/etc/shadow` and `/etc/sudoers`.

## 1. Inventory
- OS: Kali GNU/Linux Rolling 2026.3, kernel 7.1.5+kali-amd64, VMware guest
- Uptime: 18 h. CPU: i5-10300H, 4 vCPU. RAM: 7.7 GiB, 4.8 GiB available. Swap: 953 MiB, 227 MiB used.
- Disk: `/dev/sda1` ext4, 98 GB, **98% used, 2.4 GB free**. `/tmp` is tmpfs.
- Packages: 3599 installed, 34 upgradable (gnutls, wireshark/tshark, gtk4, pipewire, openssh-client-gssapi, imagemagick libs, setuptools and others).

## 2. Findings ranked by severity

### HIGH
1. **SSH server allows root login and password authentication.**
   - `/etc/ssh/sshd_config` has `PermitRootLogin yes` and `PasswordAuthentication yes`.
   - The sshd service state was not checked. The listener list shows nothing on port 22, so the setting may be dormant.
   - Fix: set `PermitRootLogin no` and `PasswordAuthentication no`, use key-only login, and keep sshd disabled unless needed.
2. **Services listen on all interfaces with no firewall confirmed.**
   - Listeners on `0.0.0.0`/`::`: 80 (apache2), 8834 (Nessus), 8081, 8025 and 1025 (unidentified; ports 8025/1025 look like a mail-testing tool).
   - The firewall ruleset could not be read without root. `ufw` is not installed.
   - Fix: bind the services to 127.0.0.1 where possible, add an nftables default-deny inbound policy, and disable services that are not needed (`systemctl disable --now apache2 nessusd`).
3. **Root disk is 98% full.**
   - A full disk can break logging, apt, docker and databases.
   - Fix: run `apt clean`, `docker system prune` (review first), and clear old venvs and caches. `core/venv` and `core/.sauron_venv` are both present and are probably duplicates.
4. **User `kali` has broad privileges and runs an unrestricted agent.**
   - `kali` is in the `sudo` and `adm` groups. Whether sudo needs a password was not verified.
   - A `claude --dangerously-skip-permissions` process (pid 492369) is running as `kali`, so any prompt injection in agent input could run arbitrary commands.
   - Fix: run agents in a sandbox or container, avoid `--dangerously-skip-permissions`, and require a sudo password.

### MEDIUM
5. **Pending updates (34), including security-relevant libraries.** gnutls, wireshark/tshark, gtk4, pipewire and imagemagick libs are behind. Fix: `sudo apt update && sudo apt full-upgrade`, then reboot.
6. **No password aging policy.** `PASS_MAX_DAYS 99999`, `PASS_MIN_DAYS 0`. Fix: set a sane maximum such as 365 days and enforce complexity with `pam_pwquality`.
7. **Large set of SUID binaries beyond the default.**
   - Includes `kismet_cap_*` (10), `rsh-redone-rsh`/`rsh-redone-rlogin`, `pppd`, `mount.cifs`, `mount.nfs`, `ksu.mit`, `ntfs-3g` and `pkexec`.
   - The rsh clients are legacy and insecure.
   - Fix: remove `rsh-redone-client`. For kismet, use the `kismet` group instead of setuid. Remove `pppd`/`ksu` if unused.
8. **Docker, MariaDB and Nessus run at boot.**
   - MariaDB is bound to 127.0.0.1:3306, which is acceptable.
   - Docker is enabled, and its socket is group `docker`. `kali` is not in that group, which is good.
   - Fix: enable these services only when needed.
9. **World-writable directories without the sticky bit.** Six directories under `~/.cache/vmware/drag_and_drop/` are affected. Fix: `chmod o-w` on them, or delete the cache.

### LOW / INFO
10. **Stray files in `core/` are not sensitive.**
    - `newcookies.txt` contains only the curl header and no cookies.
    - `wordlist.txt` is a list of 11 words (login, admin and so on).
    - `models.txt` lists fake model paths under `/opt/antigravity`.
    - `result.txt`, `exit_code.txt`, `still_running.txt`, `terminals.txt`, `current_terminals.txt`, `kill_log.txt`, `sessions_*.txt` and `session_diff.txt` are scratch output.
    - None of these is gitignored; all show as untracked (`??`).
    - Fix: delete them, or add `core/*.txt` with exceptions for `requirements*.txt` to `.gitignore`. The scratch `.sh` scripts, `smoke_task.yaml` and `test_task.yaml` need the same review before committing.
11. **Possible hard-coded secrets.** A pattern scan matched `providers/custom.py:72` (`"dummy-key-for-unauthenticated-endpoint"`) and `providers/dial.py:144` (`"placeholder-not-used"`). Both are placeholders, not real secrets. The other four matches are test files and were not reviewed.
12. **Accounts look clean.**
    - UID 0 is `root` only. Login users are `root` and `kali`.
    - There is no `~/.ssh/authorized_keys`; `~/.ssh` has `known_hosts`, an `agent` directory and mode 700.
    - `/etc/sudoers` and `sudoers.d` were unreadable, so entries are unverified.
13. **Cron and timers are normal.** `/etc/cron.d` has `john`, `php`, `sysstat` and `e2scrub_all`; `cron.daily` has `apache2`, `apt-compat`, `dpkg`, `logrotate`, `man-db`, `plocate` and `sysstat`. `kali` has no crontab. Ten systemd timers are all standard. The `john` file's contents were not displayed.
14. **Logins.** `last` shows only `kali` (local X session via lightdm). Failed logins could not be read because `lastb` is not installed and root is required.
15. **Processes.** No unexpected processes. Active: Xorg, nessusd, dockerd, the `agy` and `claude` agent processes, and a `bun test` run. All outbound connections are HTTPS (443) from `claude` and `agy`.

## 3. Quick remediation checklist
```
sudo apt update && sudo apt full-upgrade
sudo sed -i 's/^PermitRootLogin.*/PermitRootLogin no/;s/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl disable --now apache2 nessusd   # if not needed
sudo apt clean && docker system prune          # review before confirming
sudo apt remove rsh-redone-client
rm core/{newcookies,wordlist,models,result,exit_code,still_running,terminals,current_terminals,kill_log,sessions_before,sessions_after,session_diff}.txt
```
