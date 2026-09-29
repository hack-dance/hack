/* Synthetic 64-KiB interop client. Never shutdown the raw mounted transport. */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <errno.h>
static int transfer(int fd, void *buffer, size_t length, int sending) {
    unsigned char *p=buffer;
    while(length) {
        ssize_t n=sending ? write(fd,p,length) : read(fd,p,length);
        if(n<0 && errno==EINTR)continue;
        if(n<=0)return -1;
        p+=n;length-=(size_t)n;
    }
    return 0;
}
int main(int argc,char **argv) {
    if(argc!=3 || strlen(argv[1])>=sizeof(((struct sockaddr_un *)0)->sun_path) ||
            (strcmp(argv[2],"echo") && strcmp(argv[2],"bad")))return 64;
    signal(SIGPIPE,SIG_IGN);alarm(10);
    int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)return 1;
    struct timeval timeout={5,0};
    if(setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout)) ||
            setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout)))return 2;
    struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,argv[1]);
    if(connect(fd,(struct sockaddr *)&address,sizeof(address)))return 3;
    unsigned char data[16384],header[8]={'H','K','F','1',1,0,64,0};
    if(!strcmp(argv[2],"bad")) {
        header[7]=1;
        if(transfer(fd,header,8,1) || transfer(fd,header,8,0) || memcmp(header,"HKF1\3\0\0\0",8))return 4;
        close(fd);puts("malformed-reset-ok");return 0;
    }
    for(unsigned offset=0;offset<65536;offset+=sizeof(data)) {
        for(unsigned i=0;i<sizeof(data);i++)data[i]=(unsigned char)((offset+i)%251);
        if(transfer(fd,header,8,1) || transfer(fd,data,sizeof(data),1))return 5;
    }
    memcpy(header,"HKF1\2\0\0\0",8);if(transfer(fd,header,8,1))return 6;
    unsigned total=0;
    for(unsigned frames=0;frames<65537;frames++) {
        if(transfer(fd,header,8,0) || memcmp(header,"HKF1",4))return 7;
        unsigned length=((unsigned)header[5]<<16)|((unsigned)header[6]<<8)|header[7];
        if(header[4]==2 && length==0 && total==65536){close(fd);puts("framed-half-close-ok");return 0;}
        if(header[4]!=1 || !length || length>sizeof(data) || total+length>65536)return 8;
        if(transfer(fd,data,length,0))return 9;
        for(unsigned i=0;i<length;i++)if(data[i]!=(unsigned char)((total+i)%251))return 10;
        total+=length;
    }
    return 11;
}
