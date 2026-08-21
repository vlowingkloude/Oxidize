module;

#include <algorithm>
#include <filesystem>
#include <array>
#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

export module terminal;

import files;
import json;
import boost_wrapper;

namespace oxidize::terminal {
    using WebSocket = boost_wrapper::WebSocket;
}

export namespace oxidize::terminal {

    struct TerminalProcess {
        pid_t pid {-1};
        int caller {-1};

        ~TerminalProcess() {
            if (caller >= 0) {
                ::close(caller);
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

namespace oxidize::terminal {

    std::string shell_command() {
        if (const auto* configured = std::getenv("OXIDIZE_SHELL"); configured && *configured) {
            return configured;
        }

        for (const std::string& candidate : {"/bin/bash", "/usr/bin/base"}) {
            if (::access(candidate.c_str(), X_OK) == 0) {
                return candidate;
            }
        }

        if (const auto* configured = std::getenv("SHELL"); configured && *configured) {
            return configured;
        }

        return "/bin/sh";
    }

    void resize_terminal(const int caller, const std::uint16_t cols, const std::uint16_t rows) {
        winsize size {};
        size.ws_col = std::max<std::uint16_t>(cols, 1);
        size.ws_row = std::max<std::uint16_t>(rows, 1);

        if (::ioctl(caller, TIOCSWINSZ, &size) != 0) {
            throw std::runtime_error("ioctl failed");
        }
    }

    TerminalProcess start_terminal(const std::filesystem::path& working_dir) {
        const int caller = ::posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (caller < 0) {
            throw std::runtime_error("open failed");
        }
        if (::grantpt(caller) != 0 || ::unlockpt(caller) != 0) {
            const int error = errno;
            ::close (caller);
            throw std::system_error(error, std::generic_category(), "oops");
        }

        std::array<char, 256> callee_name {};
        if (::ptsname_r(caller, callee_name.data(), callee_name.size()) != 0) {
            const int error = errno;
            ::close (caller);
            throw std::system_error(error, std::generic_category(), "oops");
        }

        const int callee = ::open(callee_name.data(), O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (callee < 0) {
            const int error = errno;
            ::close (caller);
            throw std::system_error(error, std::generic_category(), "oops");
        }

        resize_terminal(caller, 100, 28);

        const auto shell = shell_command();

        const pid_t child = ::fork();
        if (child < 0) {
            const int error = errno;
            ::close (caller);
            ::close (callee);
            throw std::system_error(error, std::generic_category(), "oops");
        }

        if (child == 0) {
            ::close(caller);
            (void)::setsid();
            (void)::ioctl(callee, TIOCSCTTY, 0);
            (void)::chdir(working_dir.c_str());
            ::dup2(callee, STDIN_FILENO);
            ::dup2(callee, STDOUT_FILENO);
            ::dup2(callee, STDERR_FILENO);
            if (callee > STDERR_FILENO) {
                ::close(callee);
            }
            ::setenv("TERM", "xterm-256color", 1);
            ::setenv("COLORTERM", "truecolor", 1);
            ::execl(shell.c_str(), shell.c_str(), nullptr);
            ::_exit(127);
        }
        ::close(callee);
        return TerminalProcess{.pid = child, .caller =  caller};
    }

    void write_all(int descriptor, std::string_view value) {
        while (!value.empty()) {
            const auto count = ::write(descriptor, value.data(), value.size());
            if (count < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw std::system_error(errno, std::generic_category(), "write failed");
            }
            value.remove_prefix(static_cast<std::size_t>(count));
        }
    }

    std::string take_utf8(std::string& pending, const bool final) {
        std::string output;
        std::size_t index = 0;

        while (index < pending.size()) {
            const auto length = files::utf8_sequence_length(static_cast<char>(pending[index]));
            if (length > 1 && index + length > pending.size() && !final) {
                break;
            }
            bool valid = length != 0 && index + length <= pending.size();
            for (std::size_t offset = 1; valid && offset < length; ++offset) {
                valid = (static_cast<unsigned char>(pending[index + offset]) & 0xc0) == 0x80;
            }

            if (valid && length > 1) {
                const auto first = static_cast<unsigned int>(static_cast<unsigned char>(pending[index]));
                const auto second = static_cast<unsigned int>(static_cast<unsigned char>(pending[index + 1]));

                if (length == 2 && first < 0xc2 ||
                    length == 3 && ((first == 0xe0 && second < 0xa0) || (first == 0xed && second >= 0xa0)) ||
                    length == 4 && ((first == 0xf0 && second < 0x90) || first > 0xf4 || (first == 0xf4 && second >= 0x90))) {
                    valid = false;
                }
            }

            if (!valid) {
                output += "\xef\xbf\xbd";
                ++index;
            } else {
                output.append(pending, index, length);
                index += length;
            }
        }
        pending.erase(0, index);
        return output;
    }

    void send_json(WebSocket& socket, const json::json_type& value) {
        const auto payload = value.dump();
        boost_wrapper::write_websocket_text(socket, payload);
    }

    void handle_client(WebSocket& socket, int caller) {
        const auto message = boost_wrapper::read_websocket(socket);

        if (!message.text) {
            write_all(caller, message.payload);
            return;
        }

        const auto value = json::json_type::parse(message.payload, nullptr, false);
        if (value.is_discarded() || !value.is_object()) {
            return;
        }

        const auto type = value.value("type", "");
        if (type == "input") {
            write_all(caller, value.value("data", ""));
        } else if (type == "resize") {
            const auto columns = std::clamp(value.value("cols", 1), 1, 65535);
            const auto rows = std::clamp(value.value("rows", 1), 1, 65535);
            resize_terminal(caller, static_cast<std::uint16_t>(columns), static_cast<std::uint16_t>(rows));
        }
    }

}

export namespace oxidize::terminal {

    void run(WebSocket& socket, const std::filesystem::path& working_dir) {
        auto process = start_terminal(working_dir);
        std::array<char, 8192> buffer {};
        std::string pending;

        while (true) {
            pollfd descriptors[] = {
                {boost_wrapper::websocket_native_handle(socket), POLLIN, 0},
                {process.caller, POLLIN, 0},
            };
            const int ready = ::poll(descriptors, 2, 100);

            if (ready < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw std::system_error(errno, std::generic_category(), "poll failed");
            }
            if ((descriptors[0].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
                handle_client(socket, process.caller);
            }
            if ((descriptors[1].revents & POLLIN) != 0) {
                const auto count = ::read(process.caller, buffer.data(), buffer.size());
                if (count > 0) {
                    pending.append(buffer.data(), static_cast<std::size_t>(count));
                    if (const auto output = take_utf8(pending, false); !output.empty()) {
                        send_json(socket, {{"type", "output"}, {"data", output}});
                    }
                }
            }
            int status = 0;
            if (const auto child = ::waitpid(process.pid, &status, WNOHANG); child == process.pid) {
                process.pid = -1;
                if (const auto output = take_utf8(pending, true); !output.empty()) {
                    send_json(socket, {{"type", "output"}, {"data", output}});
                }
                json::json_type code = nullptr;
                if (WIFEXITED(status)) {
                    code = WEXITSTATUS(status);
                }
                send_json(socket, {{"type", "exit"}, {"code", code}});
                return;
            }
        }
    }

}
