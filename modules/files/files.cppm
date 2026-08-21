module;

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>
#include <stdexcept>
#include <fstream>
#include <string_view>

export module files;

import json;

export namespace oxidize::files {

    constexpr std::size_t max_file_size = 2 * 1024 * 1024;
    constexpr std::size_t max_entries = 5000;
    constexpr std::size_t max_search_matches = 500;

    const std::vector<std::string> files_should_skip {
        ".cache", ".git", ".idea", ".vscode", "build", "dist", "node_modules", "out"
    };

    struct WorkspaceInfo {
        std::string name;
        std::filesystem::path root;
        std::string kind;
        std::optional<std::string> initial_file;
    };

    struct TreeEntry {
        std::string path;
        std::string name;
        std::string kind;
        std::size_t depth;
    };

    struct TextFile {
        std::string path;
        std::string content;
        std::size_t size;
    };

    struct SearchMatch {
        std::string path;
        std::size_t line;
        std::size_t column;
        std::string preview;
    };

}

export namespace oxidize::files {

    bool should_skip_name(const std::string_view name) {
        return std::ranges::find(files_should_skip, name) != files_should_skip.end() ||
            name.starts_with("cmake-build-");
    }

    std::string display_name(const std::filesystem::path& path) {
        const auto name = path.filename().string();
        return name.empty() || name == "." || name == "/" ? "Workspace" : name;
    }

    bool validate_relative_path(const std::string& relative) {
        if (relative.empty() || std::filesystem::path(relative).is_absolute()) {
            return false;
        }

        std::string part;
        for (std::size_t index = 0; index <= relative.size(); ++index) {
            const char character = index == relative.size() ? '/' : relative[index];
            if (character == '/' || character == '\\') {
                if (part == "." || part == "..") {
                    // we are anyway using locally
                    return false;
                }
                part.clear();
            } else {
                part.push_back(character);
            }
        }
        const auto clean = std::filesystem::path(relative).lexically_normal();
        if (!clean.empty() && (clean == "." || clean.string().starts_with(".."))) {
            return false;
        }
        return true;
    }

    bool within_root(const std::filesystem::path& root, const std::filesystem::path& path) {
        const auto relative = path.lexically_relative(root);
        return !relative.empty() && !(relative.string().starts_with(".."));
    }

    std::filesystem::path canonical_or_not_found(const std::filesystem::path& path, const std::string& shown) {
        std::error_code ec;
        auto result = std::filesystem::canonical(path, ec);
        if (ec) {
            throw std::runtime_error{"probably not found"};
        }
        return result;
    }

    std::filesystem::path resolve_existing_path(const WorkspaceInfo& workspace, const std::string& relative) {
        if (!validate_relative_path(relative)) {
            throw std::runtime_error{"invalid workspace relative"};
        }
        const auto root = canonical_or_not_found(workspace.root, workspace.root.string());
        const auto resolved = canonical_or_not_found(root / std::filesystem::path(relative), relative);
        if (!within_root(root, resolved)) {
            throw std::runtime_error{"invalid workspace path"};
        }
        return resolved;
    }

    std::filesystem::path resolve_new_path(const WorkspaceInfo& workspace, const std::string& relative) {
        if (!validate_relative_path(relative)) {
            throw std::runtime_error{"invalid workspace relative"};
        }
        const auto root = canonical_or_not_found(workspace.root, workspace.root.string());
        const auto joined = root / std::filesystem::path(relative);
        if (const auto parent = canonical_or_not_found(joined.parent_path(), relative);
            !within_root(root, parent) && parent != root) {
            throw std::runtime_error{"invalid workspace path"};
        }
        return joined;
    }

    std::filesystem::path resolve_entry_path(const WorkspaceInfo& workspace, const std::string& relative) {
        if (!validate_relative_path(relative)) {
            throw std::runtime_error{"invalid workspace relative"};
        }
        const auto root = canonical_or_not_found(workspace.root, workspace.root.string());
        const auto joined = root / std::filesystem::path(relative);
        std::error_code ec;
        const auto status = std::filesystem::symlink_status(joined, ec);
        if (ec || status.type() == std::filesystem::file_type::not_found) {
            throw std::runtime_error{"path not exist"};
        }
        if (const auto parent = canonical_or_not_found(joined.parent_path(), relative);
            !within_root(root, parent) && parent != root) {
            throw std::runtime_error{"invalid workspace path"};
        }
        return joined;
    }

    void ensure_file_in_scope(const WorkspaceInfo& workspace, const std::string& relative) {
        if (workspace.initial_file.has_value() && relative != workspace.initial_file.value()) {
            throw std::runtime_error{"path outside"};
        }
    }

    void ensure_folder_workspace(const WorkspaceInfo& workspace) {
        if (workspace.initial_file.has_value()) {
            throw std::runtime_error{"should not"};
        }
    }

    // just to make sure I won't randomly open a large binary
    bool better_not_open(const std::string& value) {
        return value.find('\0') != std::string::npos;
    }

    std::string read_all(const std::filesystem::path& path) {
        std::ifstream input(path, std::ios::binary);
        if (!input) {
            throw std::runtime_error{"Cannot open file"};
        }
        return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
    }

    std::size_t utf8_sequence_length(const unsigned char byte) {
        if (byte < 0x80) {
            return 1;
        } else if ((byte & 0xe0) == 0xc0) {
            return 2;
        } else if ((byte & 0xf0) == 0xe0) {
            return 3;
        } else if ((byte & 0xf8) == 0xf0) {
            return 4;
        }
        return 0;
    }

    bool valid_utf8_sequence(const std::string_view value, const std::size_t index, const std::size_t length) {
        if (length == 0 || index + length > value.size()) {
            return false;
        }
        for (std::size_t offset = 1; offset < length; ++offset) {
            if ((static_cast<unsigned char>(value[index + offset]) & 0xc0) != 0x80) {
                return false;
            }
        }
        const auto first = static_cast<unsigned char>(value[index]);
        const auto second = length > 1 ? static_cast<unsigned int>(static_cast<unsigned char>(value[index + 1])) : 0;
        if (length == 2 && first < 0xc2) {
            return false;
        }
        if (length == 3 && ((first == 0xe0 && second < 0xa0) || (first == 0xed && second >= 0xa0))) {
            return false;
        }
        if (length == 4 && ((first == 0xf0 && second < 0x90) || first > 0xf4 || (first == 0xf4 && second >= 0x90))) {
            return false;
        }
        return true;
    }

    std::string valid_utf8(const std::string_view value) {
        std::string result;
        result.reserve(value.size());
        for (std::size_t i = 0; i < value.size();) {
            const auto length = utf8_sequence_length(static_cast<unsigned char>(value[i]));
            if (!valid_utf8_sequence(value, i, length)) {
                result += "\xef\xbf\xbd";
                ++i;
                continue;
            }
            result.append(value.substr(i, length));
            i += length;
        }
        return result;
    }

    std::size_t utf8_count(const std::string_view value) {
        std::size_t result = 0;
        for (std::size_t i = 0; i < value.size(); ++result) {
            const auto length = utf8_sequence_length(static_cast<unsigned char>(value[i]));
            i += valid_utf8_sequence(value, i, length) ? length : 1;
        }
        return result;
    }

    std::string truncate_utf8(const std::string_view value, const std::size_t maximum) {
        std::size_t index = 0;
        for (std::size_t count = 0; count < value.size() && count < maximum; ++count) {
            const auto length = utf8_sequence_length(static_cast<unsigned char>(value[index]));
            index += valid_utf8_sequence(value, index, length) ? length : 1;
        }
        return std::string(value.substr(0, index));
    }

    std::string trim(std::string value) {
        const auto whitespace = [](unsigned char c) {return std::isspace(c); };
        value.erase(value.begin(), std::ranges::find_if_not(value.begin(), value.end(), whitespace));
        value.erase(std::ranges::find_if_not(value.rbegin(), value.rend(), whitespace).base(), value.end());
        return value;
    }

    std::string ascii_lowercase(std::string value) {
        std::ranges::transform(value.begin(), value.end(), value.begin(), ::tolower);
        return value;
    }

    std::vector<TreeEntry> list_directory_entries(const std::filesystem::path& root,
                                                  const std::filesystem::path& relative_dir) {
        std::vector<std::filesystem::directory_entry> children;
        for (const auto& child : std::filesystem::directory_iterator(root / relative_dir)) {
            children.push_back(child);
        }

        std::ranges::sort(children, [](const auto& left, const auto& right) {
            std::error_code left_ec, right_ec;
            const bool left_dir = left.is_directory(left_ec) && !left.is_symlink(left_ec);
            const bool right_dir = right.is_directory(right_ec) && !right.is_symlink(right_ec);
            if (left_dir != right_dir) {
                return left_dir;
            }
            return left.path().filename().string() < right.path().filename().string();
        });
        std::vector<TreeEntry> entries;
        entries.reserve(std::min(children.size(), max_entries));
        for (const auto& child : children) {
            if (entries.size() >= max_entries) {
                break;
            }
            const auto name = child.path().filename().string();
            if (should_skip_name(name)) {
                continue;
            }
            const auto relative = relative_dir / child.path().filename();
            std::error_code ec;
            const bool symlink = child.is_symlink(ec);
            const bool dir = !symlink && child.is_directory(ec);
            const auto path = relative.generic_string();
            entries.push_back({
            path, name, dir ? "directory" : "file", static_cast<std::size_t>(std::ranges::count(path, '/'))
            });
        }
        return entries;
    }

    void search_file(const WorkspaceInfo& workspace, const std::string& relative, const std::string& query,
        const bool case_sensitive, std::vector<SearchMatch>& matches) {
        const auto path = resolve_existing_path(workspace, relative);
        std::error_code ec;
        if (std::filesystem::file_size(path, ec) > max_file_size && !ec) {
            throw std::runtime_error{"file too large"};
        }
        std::ifstream input(path, std::ios::binary);
        if (!input) {
            throw std::runtime_error{"Cannot open file"};
        }
        std::string line;
        std::size_t line_number = 0;
        const auto needle = case_sensitive ? query : ascii_lowercase(query);
        while (std::getline(input, line)) {
            ++line_number;
            if (better_not_open(line)) {
                throw std::runtime_error{"You may not want to open file"};
            }
            const auto searchable = case_sensitive ? line : ascii_lowercase(line);
            std::size_t offset = 0;
            while (offset <= searchable.size()) {
                const auto found = searchable.find(needle, offset);
                if (found == std::string::npos) {
                    break;
                }
                auto preview = trim(valid_utf8(line));
                if (utf8_count(preview) > 300) {
                    preview = truncate_utf8(preview, 300);
                }
                matches.push_back({
                    relative, line_number,
                    utf8_count(std::string_view(line).substr(0, found)) + 1,
                    std::move(preview)
                });
                if (matches.size() >= max_search_matches) {
                    return;
                }
                offset = found + std::max<std::size_t>(needle.size(),  1);
            }
        }
    }

    void search_directory(const WorkspaceInfo& workspace, const std::filesystem::path& root,
        const std::filesystem::path& relative_dir, const std::string& query,
        const bool case_sensitive, std::vector<SearchMatch>& matches) {
        if (matches.size() >= max_search_matches) {
            return;
        }
        for (const auto& child : std::filesystem::directory_iterator(root / relative_dir)) {
            if (matches.size() >= max_search_matches) {
                break;
            }
            const auto name = child.path().filename().string();
            if (should_skip_name(name)) {
                continue;
            }
            const auto relative = relative_dir / child.path().filename();
            std::error_code ec;
            const bool symlink = child.is_symlink(ec);
            if (!symlink && child.is_directory(ec)) {
                search_directory(workspace, root, relative, query, case_sensitive, matches);
            } else if (!symlink && child.is_regular_file(ec)) {
                search_file(workspace, relative.generic_string(), query, case_sensitive, matches);
            }
        }
    }

    WorkspaceInfo open_workspace(const std::filesystem::path& path) {
        std::error_code ec;
        const auto resolved = std::filesystem::canonical(path, ec);
        if (ec) {
            throw std::runtime_error{"Cannot open workspace path"};
        }
        const auto status = std::filesystem::status(resolved, ec);
        if (ec) {
            throw std::runtime_error{"Cannot open workspace status"};
        }
        if (std::filesystem::is_directory(status)) {
            return {
                display_name(resolved), resolved, "folder", std::nullopt
            };
        }
        if (std::filesystem::is_regular_file(status)) {
            const auto name = resolved.filename().string();
            return {name, resolved.parent_path(), "file", std::make_optional(name)};
        }
        throw std::runtime_error{"What is that?"};
    }

    std::vector<TreeEntry> list_tree(const WorkspaceInfo& workspace, const std::string& relative_dir = {}) {
        if (workspace.initial_file.has_value()) {
            if (!relative_dir.empty()) {
                throw std::runtime_error{"single-file workspaces do not contain directories"};
            }
            return {{workspace.initial_file.value(), workspace.initial_file.value(), "file", 0}};
        }

        if (!relative_dir.empty()) {
            if (!validate_relative_path(relative_dir)) {
                throw std::runtime_error{"invalid directory path"};
            }
            const auto directory = resolve_existing_path(workspace, relative_dir);
            std::error_code error;
            if (!std::filesystem::is_directory(directory, error) || error) {
                throw std::runtime_error{"tree path is not a directory"};
            }
        }
        return list_directory_entries(workspace.root,
                                      relative_dir.empty() ? std::filesystem::path{} : std::filesystem::path(relative_dir));
    }

    void collect_workspace_files(const std::filesystem::path& root, const std::filesystem::path& relative_dir,
                                 std::vector<TreeEntry>& entries) {
        if (entries.size() >= max_entries) return;
        for (const auto& child : std::filesystem::directory_iterator(root / relative_dir)) {
            if (entries.size() >= max_entries) break;
            const auto name = child.path().filename().string();
            if (should_skip_name(name)) continue;
            const auto relative = relative_dir / child.path().filename();
            std::error_code error;
            const bool symlink = child.is_symlink(error);
            if (!symlink && child.is_directory(error)) {
                collect_workspace_files(root, relative, entries);
            } else if (!symlink && child.is_regular_file(error)) {
                const auto path = relative.generic_string();
                entries.push_back({path, name, "file", static_cast<std::size_t>(std::ranges::count(path, '/'))});
            }
        }
    }

    std::vector<TreeEntry> list_workspace_files(const WorkspaceInfo& workspace) {
        if (workspace.initial_file.has_value()) return list_tree(workspace);
        std::vector<TreeEntry> entries;
        collect_workspace_files(workspace.root, {}, entries);
        std::ranges::sort(entries, {}, &TreeEntry::path);
        return entries;
    }

    TextFile read_text_file(const WorkspaceInfo& workspace, const std::string& relative) {
        ensure_file_in_scope(workspace, relative);
        const auto path = resolve_existing_path(workspace, relative);
        std::error_code ec;
        if (!std::filesystem::is_regular_file(path, ec)) {
            throw std::runtime_error{"I know you made a mistake"};
        }
        const auto size = std::filesystem::file_size(path);
        if (size > max_file_size) {
            throw std::runtime_error{"don't open this large file"};
        }
        auto content = read_all(path);
        if (better_not_open(content)) {
            throw std::runtime_error{"better not open file"};
        }
        return {relative, valid_utf8(content), size};
    }

    TextFile write_text_file(const WorkspaceInfo& workspace, const std::string& relative, const std::string& content) {
        ensure_file_in_scope(workspace, relative);
        const auto path = resolve_existing_path(workspace, relative);
        std::error_code ec;
        if (!std::filesystem::is_regular_file(path, ec) || ec) {
            throw std::runtime_error{"I know you made a mistake"};
        }
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output.write(content.data(), static_cast<std::streamsize>(content.size()));
        if (!output) {
            throw std::runtime_error{"Cannot write to file"};
        }
        return {relative, content, content.size()};
    }

    std::filesystem::path raw_file_path(const WorkspaceInfo& workspace, const std::string& relative) {
        ensure_file_in_scope(workspace, relative);
        const auto path = resolve_existing_path(workspace, relative);
        std::error_code ec;
        if (!std::filesystem::is_regular_file(path, ec) || ec) {
            throw std::runtime_error{"I know you made a mistake"};
        }
        return path;
    }

    void create_entry(const WorkspaceInfo& workspace, const std::string& relative, const std::string& kind) {
        ensure_folder_workspace(workspace);
        const auto path = resolve_new_path(workspace, relative);
        std::error_code ec;
        if (std::filesystem::exists(std::filesystem::symlink_status(path, ec))) {
            throw std::runtime_error{"path already exists"};
        }
        if (kind == "file") {
            std::ofstream output(path, std::ios::binary | std::ios::app);
            if (!output) {
                throw std::runtime_error{"Cannot create file"};
            }
        } else if (kind == "directory") {
            if (!std::filesystem::create_directory(path, ec) || ec) {
                throw std::runtime_error{"Cannot create directory"};
            }
        } else {
            throw std::runtime_error{"what is that?"};
        }
    }

    void rename_entry(const WorkspaceInfo& workspace, const std::string& relative, const std::string& dest) {
        ensure_folder_workspace(workspace);
        const auto source = resolve_entry_path(workspace, relative);
        const auto target = resolve_new_path(workspace, dest);
        std::error_code ec;
        if (std::filesystem::exists(std::filesystem::symlink_status(target, ec))) {
            throw std::runtime_error{"path already exists"};
        }
        std::filesystem::rename(source, target, ec);
        if (ec) {
            throw std::runtime_error{"Cannot rename file"};
        }
    }

    void delete_entry(const WorkspaceInfo& workspace, const std::string& relative) {
        ensure_folder_workspace(workspace);
        const auto path = resolve_entry_path(workspace, relative);
        std::error_code ec;
        const auto status = std::filesystem::status(path, ec);
        if (ec) {
            throw std::runtime_error{"Cannot delete file"};
        }
        if (std::filesystem::is_symlink(status) || !std::filesystem::is_directory(status)) {
            if (!std::filesystem::remove(path, ec) || ec) {
                throw std::runtime_error{"Cannot delete directory"};
            }
        } else {
            std::filesystem::remove_all(path, ec);
            if (ec) {
                throw std::runtime_error{"Cannot delete file"};
            }
        }
    }

    std::vector<SearchMatch> search_workspace(const WorkspaceInfo& workspace, const std::string& query, bool case_sensitive) {
        if (query.empty() || query.size() > 256) {
            throw std::runtime_error{"query is empty or too large"};
        }
        std::vector<SearchMatch> matches;
        if (workspace.initial_file.has_value()) {
            search_file(workspace, workspace.initial_file.value(), query, case_sensitive, matches);
        } else {
            search_directory(workspace, workspace.root, {}, query, case_sensitive, matches);
        }
        return matches;
    }

    void to_json(json::json_type& value, const WorkspaceInfo& workspace) {
        value = {
            {"name", workspace.name},
            {"root", workspace.root.string()},
            {"kind", workspace.kind},
            {"initial_file", workspace.initial_file.has_value() ? workspace.initial_file.value() : ""},
        };
    }

    void to_json(json::json_type& value, const TreeEntry& entry) {
        value = {
            {"path", entry.path},
            {"name", entry.name},
            {"kind", entry.kind},
            {"depth", entry.depth},
        };
    }

    void to_json(json::json_type& value, const TextFile& file) {
        value = {
            {"path", file.path},
            {"content", file.content},
            {"size", file.size},
        };
    }

    void to_json(json::json_type& value, const SearchMatch& match) {
        value = {
            {"path", match.path},
            {"line", match.line},
            {"column", match.column},
            {"preview", match.preview},
        };
    }

}
