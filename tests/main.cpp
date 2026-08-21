#include <algorithm>
#include <chrono>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

import files;
import lsp;

namespace oxidize::tests {
    using TestFunction = void (*)();

    struct TestCase {
        std::string_view name;
        TestFunction function;
    };

    std::vector<TestCase>& registry() {
        static std::vector<TestCase> tests;
        return tests;
    }

    struct Registration {
        Registration(const std::string_view name, const TestFunction function) {
            registry().push_back({name, function});
        }
    };

    void check(const bool condition, const std::string_view expression, const std::string_view file, const int line) {
        if (!condition) {
            throw std::runtime_error(
                std::string(file) + ':' + std::to_string(line) + ": check failed: " + std::string(expression));
        }
    }

    template<typename Function>
    void check_throws(Function&& function, const std::string_view expression,
                      const std::string_view file, const int line) {
        try {
            std::forward<Function>(function)();
        } catch (const std::exception&) {
            return;
        }
        throw std::runtime_error(
            std::string(file) + ':' + std::to_string(line) + ": expected exception: " + std::string(expression));
    }

    class TemporaryDirectory {
    public:
        TemporaryDirectory() {
            const auto seed = std::chrono::steady_clock::now().time_since_epoch().count();
            for (int attempt = 0; attempt < 100; ++attempt) {
                auto candidate = std::filesystem::temp_directory_path() /
                    ("oxidize-tests-" + std::to_string(seed) + '-' + std::to_string(attempt));
                std::error_code error;
                if (std::filesystem::create_directory(candidate, error)) {
                    path_ = std::move(candidate);
                    return;
                }
            }
            throw std::runtime_error("failed to create temporary test directory");
        }

        TemporaryDirectory(const TemporaryDirectory&) = delete;
        TemporaryDirectory& operator=(const TemporaryDirectory&) = delete;

        ~TemporaryDirectory() {
            std::error_code ignored;
            std::filesystem::remove_all(path_, ignored);
        }

        const std::filesystem::path& path() const {
            return path_;
        }

    private:
        std::filesystem::path path_;
    };

    void write_file(const std::filesystem::path& path, const std::string_view content) {
        if (const auto parent = path.parent_path(); !parent.empty()) {
            std::filesystem::create_directories(parent);
        }
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output.write(content.data(), static_cast<std::streamsize>(content.size()));
        if (!output) {
            throw std::runtime_error("failed to write test file: " + path.string());
        }
    }

    bool has_entry(const std::vector<files::TreeEntry>& entries,
                   const std::string_view path, const std::string_view kind) {
        return std::ranges::any_of(entries, [&](const auto& entry) {
            return entry.path == path && entry.kind == kind;
        });
    }
}

#define OXIDIZE_TEST(name) \
    static void name(); \
    static const ::oxidize::tests::Registration registration_##name(#name, &name); \
    static void name()

#define CHECK(expression) \
    ::oxidize::tests::check(static_cast<bool>(expression), #expression, __FILE__, __LINE__)

#define CHECK_EQ(left, right) \
    do { \
        const auto& actual_value = (left); \
        const auto& expected_value = (right); \
        ::oxidize::tests::check(actual_value == expected_value, #left " == " #right, __FILE__, __LINE__); \
    } while (false)

#define CHECK_THROWS(expression) \
    ::oxidize::tests::check_throws([&] { (void)(expression); }, #expression, __FILE__, __LINE__)

namespace {
    namespace files = oxidize::files;
    namespace lsp = oxidize::lsp;
    using oxidize::tests::TemporaryDirectory;
    using oxidize::tests::has_entry;
    using oxidize::tests::write_file;

    OXIDIZE_TEST(relative_path_validation) {
        CHECK(files::validate_relative_path("src/main.cpp"));
        CHECK(files::validate_relative_path("one"));
        CHECK(!files::validate_relative_path(""));
        CHECK(!files::validate_relative_path("/absolute"));
        CHECK(!files::validate_relative_path("../escape"));
        CHECK(!files::validate_relative_path("src/../escape"));
        CHECK(!files::validate_relative_path("./file"));
    }

    OXIDIZE_TEST(folder_workspace_and_tree) {
        TemporaryDirectory directory;
        write_file(directory.path() / "src/main.cpp", "int main() {}\n");
        write_file(directory.path() / ".git/config", "ignored\n");
        write_file(directory.path() / "build/generated.cpp", "ignored\n");
        write_file(directory.path() / "node_modules/package/index.js", "ignored\n");
        write_file(directory.path() / "notes.txt", "notes\n");

        const auto workspace = files::open_workspace(directory.path());
        CHECK_EQ(workspace.kind, "folder");
        CHECK_EQ(workspace.root, std::filesystem::canonical(directory.path()));
        CHECK(!workspace.initial_file.has_value());

        const auto entries = files::list_tree(workspace);
        CHECK(has_entry(entries, "src", "directory"));
        CHECK(!has_entry(entries, "src/main.cpp", "file"));
        CHECK(has_entry(entries, "notes.txt", "file"));
        CHECK(!std::ranges::any_of(entries, [](const auto& entry) {
            return entry.path.starts_with(".git") || entry.path.starts_with("build") ||
                entry.path.starts_with("node_modules");
        }));

        const auto source_entries = files::list_tree(workspace, "src");
        CHECK_EQ(source_entries.size(), std::size_t{1});
        CHECK(has_entry(source_entries, "src/main.cpp", "file"));
        CHECK_EQ(source_entries.front().depth, std::size_t{1});
        CHECK_THROWS(files::list_tree(workspace, "notes.txt"));
        CHECK_THROWS(files::list_tree(workspace, "../outside"));
        CHECK(files::should_skip_name("node_modules"));
        CHECK(files::should_skip_name("cmake-build-release"));
        CHECK(!files::should_skip_name("src"));

        const auto workspace_files = files::list_workspace_files(workspace);
        CHECK(has_entry(workspace_files, "src/main.cpp", "file"));
        CHECK(has_entry(workspace_files, "notes.txt", "file"));
    }

    OXIDIZE_TEST(file_lifecycle) {
        TemporaryDirectory directory;
        const auto workspace = files::open_workspace(directory.path());

        files::create_entry(workspace, "include", "directory");
        files::create_entry(workspace, "include/value.hpp", "file");
        const auto written = files::write_text_file(workspace, "include/value.hpp", "#pragma once\n");
        CHECK_EQ(written.content, "#pragma once\n");
        CHECK_EQ(files::read_text_file(workspace, "include/value.hpp").content, "#pragma once\n");

        files::rename_entry(workspace, "include/value.hpp", "include/result.hpp");
        CHECK(!std::filesystem::exists(directory.path() / "include/value.hpp"));
        CHECK(std::filesystem::is_regular_file(directory.path() / "include/result.hpp"));

        files::delete_entry(workspace, "include");
        CHECK(!std::filesystem::exists(directory.path() / "include"));
        CHECK_THROWS(files::create_entry(workspace, "invalid", "socket"));
    }

    OXIDIZE_TEST(workspace_search) {
        TemporaryDirectory directory;
        write_file(directory.path() / "content.txt",
                   "Alpha beta\nalpha gamma\n\xc3\xa9\xc3\xa9 needle\n");
        const auto workspace = files::open_workspace(directory.path());

        const auto insensitive = files::search_workspace(workspace, "alpha", false);
        CHECK_EQ(insensitive.size(), std::size_t{2});
        CHECK_EQ(insensitive[0].line, std::size_t{1});
        CHECK_EQ(insensitive[1].line, std::size_t{2});

        const auto sensitive = files::search_workspace(workspace, "Alpha", true);
        CHECK_EQ(sensitive.size(), std::size_t{1});
        CHECK_EQ(sensitive[0].line, std::size_t{1});

        const auto unicode = files::search_workspace(workspace, "needle", true);
        CHECK_EQ(unicode.size(), std::size_t{1});
        CHECK_EQ(unicode[0].line, std::size_t{3});
        CHECK_EQ(unicode[0].column, std::size_t{4});
    }

    OXIDIZE_TEST(workspace_path_containment) {
        TemporaryDirectory directory;
        TemporaryDirectory outside;
        write_file(directory.path() / "inside.txt", "inside\n");
        write_file(outside.path() / "outside.txt", "outside\n");
        const auto workspace = files::open_workspace(directory.path());

        CHECK_THROWS(files::read_text_file(workspace, "../outside.txt"));
        CHECK_THROWS(files::create_entry(workspace, "../created.txt", "file"));

        std::error_code error;
        std::filesystem::create_symlink(
            outside.path() / "outside.txt", directory.path() / "escape.txt", error);
        CHECK(!error);
        CHECK_THROWS(files::read_text_file(workspace, "escape.txt"));
    }

    OXIDIZE_TEST(single_file_workspace) {
        TemporaryDirectory directory;
        const auto path = directory.path() / "standalone.cpp";
        write_file(path, "int answer = 42;\n");

        const auto workspace = files::open_workspace(path);
        CHECK_EQ(workspace.kind, "file");
        CHECK_EQ(workspace.root, std::filesystem::canonical(path).parent_path());
        CHECK_EQ(workspace.initial_file, std::optional<std::string>{"standalone.cpp"});

        const auto entries = files::list_tree(workspace);
        CHECK_EQ(entries.size(), std::size_t{1});
        CHECK_EQ(files::read_text_file(workspace, "standalone.cpp").content, "int answer = 42;\n");
        CHECK_THROWS(files::read_text_file(workspace, "other.cpp"));
        CHECK_THROWS(files::create_entry(workspace, "other.cpp", "file"));
    }

    OXIDIZE_TEST(utf8_and_binary_detection) {
        const std::string accented = "\xc3\xa9x";
        CHECK_EQ(files::utf8_sequence_length(0xc3), std::size_t{2});
        CHECK(files::valid_utf8_sequence(accented, 0, 2));
        CHECK_EQ(files::utf8_count(accented), std::size_t{2});
        CHECK_EQ(files::truncate_utf8(accented, 1), std::string{"\xc3\xa9"});
        CHECK_EQ(files::valid_utf8(std::string{"\xff", 1}), std::string{"\xef\xbf\xbd"});
        CHECK(files::better_not_open(std::string{"a\0b", 3}));

        TemporaryDirectory directory;
        write_file(directory.path() / "binary.dat", std::string_view{"a\0b", 3});
        const auto workspace = files::open_workspace(directory.path());
        CHECK_THROWS(files::read_text_file(workspace, "binary.dat"));
    }

    OXIDIZE_TEST(lsp_protocol_helpers) {
        const auto fields = lsp::split_fields("clangd --background-index --clang-tidy");
        CHECK_EQ(fields.size(), std::size_t{3});
        CHECK_EQ(fields[0], "clangd");
        CHECK_EQ(fields[2], "--clang-tidy");

        const auto paths = lsp::split_paths("/bin::/usr/bin");
        CHECK_EQ(paths.size(), std::size_t{2});
        CHECK_EQ(paths[0], std::filesystem::path{"/bin"});
        CHECK_EQ(paths[1], std::filesystem::path{"/usr/bin"});
        CHECK(lsp::split_paths(nullptr).empty());

        const auto windows = lsp::parse_content_length("Content-Length: 42\r\nContent-Type: test\r\n\r\n");
        CHECK(windows.has_value());
        CHECK_EQ(*windows, std::size_t{42});

        const auto line_feed_headers = lsp::parse_content_length("content-length: 7\n\n");
        CHECK(line_feed_headers.has_value());
        CHECK_EQ(*line_feed_headers, std::size_t{7});
        CHECK(!lsp::parse_content_length("Content-Length: 7x\r\n\r\n").has_value());
        CHECK(!lsp::parse_content_length("Content-Type: test\r\n\r\n").has_value());
        CHECK_EQ(lsp::lowercase("ClAnGd"), "clangd");
        CHECK(lsp::language_server_for("cpp").has_value());
        CHECK(!lsp::language_server_for("unsupported").has_value());
    }
}

int main() {
    std::size_t failures = 0;
    for (const auto& test : oxidize::tests::registry()) {
        try {
            test.function();
            std::cout << "[PASS] " << test.name << '\n';
        } catch (const std::exception& caught) {
            ++failures;
            std::cerr << "[FAIL] " << test.name << ": " << caught.what() << '\n';
        } catch (...) {
            ++failures;
            std::cerr << "[FAIL] " << test.name << ": unknown exception\n";
        }
    }

    const auto total = oxidize::tests::registry().size();
    std::cout << (total - failures) << '/' << total << " tests passed\n";
    return failures == 0 ? 0 : 1;
}
