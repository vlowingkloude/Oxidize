module;

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <poll.h>
#include <ranges>
#include <set>
#include <string>
#include <system_error>
#include <unordered_map>
#include <vector>

#if defined(__linux__)
#include <sys/inotify.h>
#include <unistd.h>
#endif

export module watcher;

import json;
import files;
import boost_wrapper;

export namespace oxidize::watcher {

    struct Fingerprint {
        bool directory;
        std::size_t size;
        std::size_t modified;
        std::uint32_t mode;
        bool operator==(const Fingerprint&) const = default;
    };

    struct FileChange {
        std::string kind;
        std::string path;
    };

}

namespace oxidize::watcher {
    using WebSocket = boost_wrapper::WebSocket;
    namespace fs = std::filesystem;

    constexpr std::size_t max_watch_entries = 20000;
    constexpr std::size_t max_changes = 500;
    constexpr auto change_debounce = std::chrono::milliseconds(75);

    using Snapshot = std::map<std::string, Fingerprint>;

    void to_json(json::json_type& value, const FileChange& change) {
        value = {{"kind", change.kind}, {"path", change.path}};
    }

    void send_changes(WebSocket& socket, const std::vector<FileChange>& changes) {
        const auto payload = json::json_type{{"type", "changes"}, {"changes", changes}}.dump();
        boost_wrapper::write_websocket_text(socket, payload);
    }

    void merge_change(std::vector<FileChange>& changes, FileChange change) {
        if (change.kind == "resync") {
            changes = {{"resync", ""}};
            return;
        }
        if (change.path.empty() || (!changes.empty() && changes.front().kind == "resync")) {
            return;
        }
        const auto found = std::ranges::find(changes, change.path, &FileChange::path);
        if (found != changes.end()) {
            if (found->kind == "created" && change.kind == "modified") {
                return;
            }
            if (found->kind == "created" && change.kind == "removed") {
                changes.erase(found);
                return;
            }
            if (found->kind == "removed" && change.kind == "created") {
                found->kind = "modified";
                return;
            }
            *found = std::move(change);
            return;
        }
        if (changes.size() >= max_changes) {
            changes = {{"resync", ""}};
            return;
        }
        changes.push_back(std::move(change));
    }

    std::uint32_t mode_value(const fs::file_status status) {
        return static_cast<std::uint32_t>(status.permissions()) |
            (static_cast<std::uint32_t>(status.type()) << 16);
    }

    void add_fingerprint(const fs::path& root, const fs::path& relative, Snapshot& entries) {
        std::error_code error;
        const auto status = fs::symlink_status(root / relative, error);
        if (error) {
            throw std::system_error(error);
        }
        std::size_t size = 0;
        if (fs::is_regular_file(status)) {
            size = fs::file_size(root / relative, error);
            if (error) {
                throw std::system_error(error);
            }
        }
        std::size_t modified = 0;
        const auto time = fs::last_write_time(root / relative, error);
        if (!error) {
            modified = static_cast<std::size_t>(time.time_since_epoch().count());
        }
        entries[relative.generic_string()] = {fs::is_directory(status), size, modified, mode_value(status)};
    }

    void collect_snapshot(const fs::path& root, const fs::path& relative_dir, Snapshot& entries) {
        if (entries.size() >= max_watch_entries) {
            return;
        }
        std::vector<fs::directory_entry> children;
        for (const auto& child : fs::directory_iterator(root / relative_dir)) {
            children.push_back(child);
        }
        std::ranges::sort(children, {}, [](const auto& child) { return child.path().filename().string(); });
        for (const auto& child : children) {
            if (entries.size() >= max_watch_entries) {
                break;
            }
            const auto name = child.path().filename().string();
            if (files::should_skip_name(name)) {
                continue;
            }
            const auto relative = relative_dir / child.path().filename();
            add_fingerprint(root, relative, entries);
            std::error_code error;
            if (!child.is_symlink(error) && child.is_directory(error)) {
                collect_snapshot(root, relative, entries);
            }
        }
    }

    Snapshot workspace_snapshot(const files::WorkspaceInfo& workspace) {
        Snapshot entries;
        if (workspace.initial_file.has_value()) {
            add_fingerprint(workspace.root, workspace.initial_file.value(), entries);
        } else {
            collect_snapshot(workspace.root, {}, entries);
        }
        return entries;
    }

    std::vector<FileChange> compare_snapshots(const Snapshot& previous, const Snapshot& current) {
        std::set<std::string> paths;
        for (const auto& path : std::ranges::views::keys(previous)) paths.insert(path);
        for (const auto& path : std::ranges::views::keys(current)) paths.insert(path);

        std::vector<FileChange> changes;
        for (const auto& path : paths) {
            const auto old = previous.find(path);
            const auto next = current.find(path);
            if (old == previous.end()) merge_change(changes, {"created", path});
            else if (next == current.end()) merge_change(changes, {"removed", path});
            else if (old->second != next->second) merge_change(changes, {"modified", path});
        }
        return changes;
    }

    void run_snapshot(WebSocket& socket, const files::WorkspaceInfo& workspace) {
        auto previous = workspace_snapshot(workspace);
        while (true) {
            pollfd descriptor{boost_wrapper::websocket_native_handle(socket), POLLIN, 0};
            const int ready = ::poll(&descriptor, 1, 1200);
            if (ready < 0) {
                if (errno == EINTR) continue;
                throw std::system_error(errno, std::generic_category(), "socket poll watch failed");
            }
            if (ready > 0 && (descriptor.revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
                (void)boost_wrapper::read_websocket(socket);
                continue;
            }
            if (ready != 0) continue;

            Snapshot current;
            try {
                current = workspace_snapshot(workspace);
            } catch (...) {
                continue;
            }
            const auto changes = compare_snapshots(previous, current);
            previous = std::move(current);
            if (!changes.empty()) send_changes(socket, changes);
        }
    }

#if defined(__linux__)
    class InotifyWatcher {
    public:
        explicit InotifyWatcher(const files::WorkspaceInfo& workspace) : workspace_(workspace) {
            descriptor_ = ::inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
            if (descriptor_ < 0) {
                throw std::system_error(errno, std::generic_category(), "inotify initialization failed");
            }
            try {
                if (workspace_.initial_file.has_value()) add_directory({});
                else add_directory_tree({});
            } catch (...) {
                ::close(descriptor_);
                descriptor_ = -1;
                throw;
            }
        }

        InotifyWatcher(const InotifyWatcher&) = delete;
        InotifyWatcher& operator=(const InotifyWatcher&) = delete;

        ~InotifyWatcher() {
            if (descriptor_ >= 0) ::close(descriptor_);
        }

        int descriptor() const { return descriptor_; }

        std::vector<FileChange> read_changes() {
            std::vector<FileChange> changes;
            alignas(inotify_event) std::array<char, 64 * 1024> buffer{};
            while (true) {
                const auto count = ::read(descriptor_, buffer.data(), buffer.size());
                if (count < 0) {
                    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                    if (errno == EINTR) continue;
                    throw std::system_error(errno, std::generic_category(), "inotify read failed");
                }
                if (count == 0) break;

                std::size_t offset = 0;
                while (offset < static_cast<std::size_t>(count)) {
                    const auto* event = reinterpret_cast<const inotify_event*>(buffer.data() + offset);
                    offset += sizeof(inotify_event) + event->len;
                    if ((event->mask & IN_Q_OVERFLOW) != 0) {
                        merge_change(changes, {"resync", ""});
                        continue;
                    }

                    const auto watched = directories_.find(event->wd);
                    if (watched == directories_.end()) continue;
                    const auto parent = watched->second;
                    if ((event->mask & IN_IGNORED) != 0) {
                        directories_.erase(watched);
                        continue;
                    }

                    const std::string name = event->len == 0 ? std::string{} : std::string(event->name);
                    if (!name.empty() && files::should_skip_name(name)) continue;
                    const auto relative = name.empty() ? parent : parent / name;
                    const auto path = relative.generic_string();
                    if (workspace_.initial_file.has_value() && path != workspace_.initial_file.value()) continue;

                    const bool directory = (event->mask & IN_ISDIR) != 0;
                    if (directory && (event->mask & (IN_DELETE | IN_MOVED_FROM)) != 0) {
                        remove_directory_tree(relative);
                    }
                    if (directory && (event->mask & (IN_CREATE | IN_MOVED_TO)) != 0) {
                        add_directory_tree(relative);
                    }

                    if ((event->mask & (IN_DELETE_SELF | IN_MOVE_SELF)) != 0) {
                        merge_change(changes, {"resync", ""});
                    } else if ((event->mask & (IN_DELETE | IN_MOVED_FROM)) != 0) {
                        merge_change(changes, {"removed", path});
                    } else if ((event->mask & (IN_CREATE | IN_MOVED_TO)) != 0) {
                        merge_change(changes, {"created", path});
                    } else if ((event->mask & (IN_CLOSE_WRITE | IN_ATTRIB)) != 0) {
                        merge_change(changes, {"modified", path});
                    }
                }
            }
            return changes;
        }

    private:
        static constexpr std::uint32_t event_mask = IN_CREATE | IN_DELETE | IN_CLOSE_WRITE | IN_ATTRIB |
            IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE_SELF | IN_MOVE_SELF;

        const files::WorkspaceInfo& workspace_;
        int descriptor_{-1};
        std::unordered_map<int, fs::path> directories_;

        void add_directory(const fs::path& relative) {
            const int watch = ::inotify_add_watch(descriptor_, (workspace_.root / relative).c_str(), event_mask);
            if (watch < 0) {
                if (errno == ENOENT) return;
                throw std::system_error(errno, std::generic_category(), "cannot watch directory");
            }
            directories_[watch] = relative;
        }

        void add_directory_tree(const fs::path& relative) {
            add_directory(relative);
            std::error_code error;
            fs::directory_iterator iterator(workspace_.root / relative,
                                            fs::directory_options::skip_permission_denied, error);
            if (error) return;
            for (const auto& child : iterator) {
                const auto name = child.path().filename().string();
                if (files::should_skip_name(name)) continue;
                std::error_code status_error;
                if (!child.is_symlink(status_error) && child.is_directory(status_error)) {
                    add_directory_tree(relative / child.path().filename());
                }
            }
        }

        void remove_directory_tree(const fs::path& relative) {
            const auto prefix = relative.generic_string() + '/';
            std::vector<int> removed;
            for (const auto& [watch, directory] : directories_) {
                const auto candidate = directory.generic_string();
                if (candidate == relative.generic_string() || candidate.starts_with(prefix)) removed.push_back(watch);
            }
            for (const int watch : removed) {
                directories_.erase(watch);
                (void)::inotify_rm_watch(descriptor_, watch);
            }
        }
    };

    void run_inotify(WebSocket& socket, InotifyWatcher& watcher) {
        std::vector<FileChange> pending;
        auto flush_at = std::chrono::steady_clock::time_point::max();
        while (true) {
            int timeout = -1;
            if (!pending.empty()) {
                const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                    flush_at - std::chrono::steady_clock::now()).count();
                timeout = static_cast<int>(std::max<std::int64_t>(0, remaining));
            }
            pollfd descriptors[] = {
                {boost_wrapper::websocket_native_handle(socket), POLLIN, 0},
                {watcher.descriptor(), POLLIN, 0},
            };
            const int ready = ::poll(descriptors, 2, timeout);
            if (ready < 0) {
                if (errno == EINTR) continue;
                throw std::system_error(errno, std::generic_category(), "watch poll failed");
            }
            if ((descriptors[0].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
                (void)boost_wrapper::read_websocket(socket);
            }
            if ((descriptors[1].revents & (POLLIN | POLLERR)) != 0) {
                for (auto change : watcher.read_changes()) merge_change(pending, std::move(change));
                if (!pending.empty()) flush_at = std::chrono::steady_clock::now() + change_debounce;
            }
            if (!pending.empty() && std::chrono::steady_clock::now() >= flush_at) {
                send_changes(socket, pending);
                pending.clear();
                flush_at = std::chrono::steady_clock::time_point::max();
            }
        }
    }
#endif
}

export namespace oxidize::watcher {

    void run(WebSocket& socket, const files::WorkspaceInfo& workspace) {
#if defined(__linux__)
        std::unique_ptr<InotifyWatcher> native;
        try {
            native = std::make_unique<InotifyWatcher>(workspace);
        } catch (...) {
            run_snapshot(socket, workspace);
            return;
        }
        run_inotify(socket, *native);
#else
        run_snapshot(socket, workspace);
#endif
    }

}
