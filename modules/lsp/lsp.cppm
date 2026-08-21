module;

#include <filesystem>
#include <array>
#include <cerrno>
#include <cctype>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <iterator>
#include <optional>
#include <poll.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <algorithm>
#include <iostream>

export module lsp;

import boost_wrapper;

export namespace oxidize::lsp {

    namespace fs = std::filesystem;
    struct LanguageServer {
        std::string command;
        std::vector<std::string> arguments;
    };

    struct Process {
        pid_t pid {-1};
        int input {-1};
        int output {-1};
        int error {-1};

        Process() = default;
        Process(const Process&) = delete;
        Process& operator=(const Process&) = delete;
        Process(Process&& other) noexcept
            : pid(std::exchange(other.pid, -1)), input(std::exchange(other.input, -1)),
              output(std::exchange(other.output, -1)), error(std::exchange(other.error, -1)) {}
        Process& operator=(Process&& other) = delete;

        ~Process() {
            if (input >= 0) {
                ::close(input);
            }
            if (output >= 0) {
                ::close(output);
            }
            if (error >= 0) {
                ::close(error);
            }
            if (pid > 0) {
                ::kill(-pid, SIGTERM);
                ::kill(pid, SIGTERM);
                int status = 0;
                for (int attempt = 0; attempt < 20; ++attempt) {
                    if (::waitpid(pid, &status, WNOHANG) == pid) {
                        return;
                    }
                    ::usleep(10000);
                }
                ::kill(-pid, SIGTERM);
                ::kill(pid, SIGTERM);
                (void)::waitpid(pid, &status, 0);
            }
        }
    };

}

export namespace oxidize::lsp {

    using WebSocket = boost_wrapper::WebSocket;

    std::vector<std::string> split_fields(const std::string& value) {
        std::istringstream input(value);
        return {
            std::istream_iterator<std::string>(input), std::istream_iterator<std::string>()
        };
    }

    std::vector<fs::path> split_paths(const char* value) {
        std::vector<fs::path> paths;
        if (value == nullptr) {
            return paths;
        }
        std::string input(value);
        std::size_t start = 0;
        while (start <= input.size()) {
            const auto end = input.find(':', start);
            const auto part = input.substr(start, end == std::string::npos ? std::string::npos : end - start);
            if (!part.empty()) {
                paths.emplace_back(part);
            }
            if (end == std::string::npos) {
                break;
            }
            start = end + 1;
        }
        return paths;
    }

    bool executable(const fs::path& path) {
        return ::access(path.c_str(), X_OK) == 0;
    }

    std::string find_in_path(const std::string& name) {
        for (const auto& directory : split_paths(std::getenv("PATH"))) {
            if (const auto candidate = directory / name; executable(candidate)) {
                return candidate.string();
            }
        }
        return {};
    }

    Process start_process(const fs::path& working_directory, const LanguageServer& language_server) {
        int input_pipe[2], output_pipe[2], error_pipe[2];
        if (::pipe(input_pipe) != 0 || ::pipe(output_pipe) != 0 || ::pipe(error_pipe) != 0) {
            throw std::system_error(errno, std::generic_category(), "failed to create language server pipes");
        }
        Process process;
        process.pid = ::fork();
        if (process.pid < 0) {
            throw std::system_error(errno, std::generic_category(), "failed to fork language server");
        }
        if (process.pid == 0) {
            (void)::setpgid(0, 0);
            (void)::chdir(working_directory.c_str());
            ::dup2(input_pipe[0], STDIN_FILENO);
            ::dup2(output_pipe[1], STDOUT_FILENO);
            ::dup2(error_pipe[1], STDERR_FILENO);
            ::close(input_pipe[0]); ::close(input_pipe[1]);
            ::close(output_pipe[0]); ::close(output_pipe[1]);
            ::close(error_pipe[0]); ::close(error_pipe[1]);
            std::vector<char*> arguments;
            arguments.push_back(const_cast<char*>(language_server.command.c_str()));
            for (const auto& argument : language_server.arguments) {
                arguments.push_back(const_cast<char*>(argument.c_str()));
            }
            arguments.push_back(nullptr);
            ::execvp(arguments[0], arguments.data());
            const auto message = std::string("failed to start ") + language_server.command + ": " + std::strerror(errno) + "\n";
            (void)::write(STDERR_FILENO, message.data(), message.size());
            ::_exit(127);
        }
        ::close(input_pipe[0]);
        ::close(output_pipe[1]);
        ::close(error_pipe[1]);
        process.input = input_pipe[1];
        process.output = output_pipe[0];
        process.error = error_pipe[0];
        return process;
    }

    void write_all(int descriptor, std::string_view value) {
        while (!value.empty()) {
            const auto count = ::write(descriptor, value.data(), value.size());
            if (count < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw std::system_error(errno, std::generic_category(), "language server write failed");
            }
            value.remove_prefix(static_cast<std::size_t>(count));
        }
    }

    void forward_client_message(WebSocket& socket, int input) {
        const auto message = boost_wrapper::read_websocket(socket);
        const auto& payload = message.payload;
        const auto header = "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n";
        write_all(input, header);
        write_all(input, payload);
    }

    std::string lowercase(std::string value) {
        std::ranges::transform(value.begin(), value.end(), value.begin(), ::tolower);
        return value;
    }

    std::optional<std::size_t> parse_content_length(const std::string& headers) {
        std::istringstream input(headers);
        std::string line;
        while (std::getline(input, line)) {
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }
            const auto colon = line.find(':');
            if (colon == std::string::npos || lowercase(line.substr(0, colon)) != "content-length") {
                continue;
            }
            auto value = line.substr(colon + 1);
            value.erase(0, value.find_first_not_of(" \t"));
            if (const auto end = value.find_last_not_of(" \t"); end == std::string::npos) {
                value.clear();
            }
            else {
                value.erase(end + 1);
            }
            try {
                std::size_t consumed = 0;
                const auto result = std::stoull(value, &consumed);
                if (consumed != value.size()) {
                    return std::nullopt;
                }
                return static_cast<std::size_t>(result);
            } catch (...) {
                return std::nullopt;
            }
        }
        return std::nullopt;
    }

    void forward_server_messages(WebSocket& socket, std::string& pending) {
        if (pending.size() > (32U << 20U) + 64U * 1024U) {
            throw std::runtime_error("language server response buffer is too large");
        }
        while (true) {
            auto header_end = pending.find("\r\n\r\n");
            std::size_t delimiter_size = 4;
            if (header_end == std::string::npos) {
                header_end = pending.find("\n\n");
                delimiter_size = 2;
            }
            if (header_end == std::string::npos) {
                return;
            }
            const auto length = parse_content_length(pending.substr(0, header_end + delimiter_size));
            if (!length) {
                throw std::runtime_error("language server response is missing or has invalid Content-Length");
            }
            if (*length > (32U << 20U)) {
                throw std::runtime_error("language server response is too large");
            }
            const auto payload_start = header_end + delimiter_size;
            if (pending.size() - payload_start < *length) {
                return;
            }
            boost_wrapper::write_websocket_text(
                socket, std::string_view(pending.data() + payload_start, *length));
            pending.erase(0, payload_start + *length);
        }
    }

    std::optional<LanguageServer> language_server_for(const std::string& language) {
        auto key = std::string("OXIDIZE_LSP_");
        for (const auto character : language) {
            key.push_back(character == '-' || character == '.' ? '_' : static_cast<char>(std::toupper(static_cast<unsigned char>(character))));
        }
        if (const auto* override_value = std::getenv(key.c_str()); override_value && *override_value) {
            auto parts = split_fields(override_value);
            if (!parts.empty()) {
                LanguageServer result{parts.front(), {parts.begin() + 1, parts.end()}};
                return result;
            }
        }
        if (language == "cpp") {
            return LanguageServer{"clangd", {}};
        }
        // if (language == "java") {
        //     return LanguageServer{"jdtls", {}};
        // }
        return std::nullopt;
    }

    void run(WebSocket& socket, const fs::path& working_directory, const LanguageServer& language_server) {
        auto process = start_process(working_directory, language_server);
        std::string pending;
        std::array<char, 8192> buffer{};
        while (true) {
            pollfd descriptors[] = {
                {boost_wrapper::websocket_native_handle(socket), POLLIN, 0},
                {process.output, POLLIN, 0},
                {process.error, POLLIN, 0},
            };
            if (const int ready = ::poll(descriptors, 3, 100); ready < 0) {
                if (errno == EINTR) continue;
                throw std::system_error(errno, std::generic_category(), "language server poll failed");
            }
            if ((descriptors[0].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
                forward_client_message(socket, process.input);
            }
            if ((descriptors[1].revents & POLLIN) != 0) {
                if (const auto count = ::read(process.output, buffer.data(), buffer.size()); count > 0) {
                    pending.append(buffer.data(), static_cast<std::size_t>(count));
                    forward_server_messages(socket, pending);
                }
            }
            if ((descriptors[2].revents & POLLIN) != 0) {
                if (const auto count = ::read(process.error, buffer.data(), buffer.size()); count > 0) {
                    std::cerr << "language server: " << std::string_view(buffer.data(), static_cast<std::size_t>(count));
                }
            }
            int status = 0;
            if (const auto child = ::waitpid(process.pid, &status, WNOHANG); child == process.pid) {
                process.pid = -1;
                return;
            }
        }
    }

}
