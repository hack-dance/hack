/* Test-only independent protocol client. Credential packet (binding96/key32) is
 * read exclusively from stdin. Never print it or shutdown the raw transport. */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <errno.h>
extern void fixture_hmac(unsigned char *,const unsigned char *,const unsigned char *,size_t);
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
static int equal(const unsigned char *a,const unsigned char *b,size_t n) {
    volatile unsigned difference=0;
    for(size_t i=0;i<n;i++)difference|=a[i]^b[i];
    return difference==0;
}
static void proof(unsigned char out[32],const unsigned char key[32],const char *domain,
                  unsigned char role,const unsigned char binding[96],const unsigned char client[32],const unsigned char server[32]) {
    unsigned char input[256];size_t n=strlen(domain)+1;
    memcpy(input,domain,n);input[n++]=role;
    memcpy(input+n,binding,96);n+=96;memcpy(input+n,client,32);n+=32;memcpy(input+n,server,32);n+=32;
    fixture_hmac(out,key,input,n);
}
static void record_tag(unsigned char out[32],const unsigned char key[32],const unsigned char *wire,size_t length) {
    static const char domain[]="Hack relay record v1";
    unsigned char input[16464];memcpy(input,domain,sizeof(domain));memcpy(input+sizeof(domain),wire,length);
    fixture_hmac(out,key,input,sizeof(domain)+length);
}
static size_t encode(unsigned char wire[16440],const unsigned char key[32],uint64_t seq,int kind,const unsigned char *data,unsigned length) {
    unsigned inner=8+length;memcpy(wire,"HKI1",4);
    for(int i=0;i<4;i++)wire[4+i]=(unsigned char)(inner>>(24-8*i));
    for(int i=0;i<8;i++)wire[8+i]=(unsigned char)(seq>>(56-8*i));
    memcpy(wire+16,"HKF1",4);wire[20]=(unsigned char)kind;
    wire[21]=(unsigned char)(length>>16);wire[22]=(unsigned char)(length>>8);wire[23]=(unsigned char)length;
    if(length)memcpy(wire+24,data,length);
    record_tag(wire+24+length,key,wire,24+length);return 56+length;
}
static int receive(int fd,const unsigned char key[32],uint64_t sequence,unsigned char wire[16440],unsigned *length) {
    if(transfer(fd,wire,8,0)||memcmp(wire,"HKI1",4))return -1;
    unsigned inner=((unsigned)wire[4]<<24)|((unsigned)wire[5]<<16)|((unsigned)wire[6]<<8)|wire[7];
    if(inner<8||inner>16392||transfer(fd,wire+8,inner+40,0))return -1;
    unsigned char tag[32];record_tag(tag,key,wire,16+inner);
    if(!equal(tag,wire+16+inner,32))return -1;
    uint64_t seen=0;for(int i=0;i<8;i++)seen=(seen<<8)|wire[8+i];
    if(seen!=sequence||memcmp(wire+16,"HKF1",4))return -1;
    *length=((unsigned)wire[21]<<16)|((unsigned)wire[22]<<8)|wire[23];
    if(*length+8!=inner)return -1;return wire[20];
}
int main(int argc,char **argv) {
    if(argc!=3||strlen(argv[1])>=sizeof(((struct sockaddr_un *)0)->sun_path))return 64;
    const char *mode=argv[2];
    if(strcmp(mode,"echo")&&strcmp(mode,"wrong-key")&&strcmp(mode,"stale")&&strcmp(mode,"tamper")&&strcmp(mode,"replay")&&strcmp(mode,"revoke"))return 64;
    signal(SIGPIPE,SIG_IGN);alarm(12);
    unsigned char packet[128],hello[136],response[64],tag[32],c2s[32],s2c[32];
    if(transfer(STDIN_FILENO,packet,sizeof(packet),0))return 1;
    memcpy(hello,"HKRA0001",8);memcpy(hello+8,packet,96);
    int random=open("/dev/urandom",O_RDONLY);if(random<0||transfer(random,hello+104,32,0))return 2;close(random);
    int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)return 3;
    struct timeval timeout={5,0};
    if(setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout))||setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout)))return 4;
    struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,argv[1]);
    if(connect(fd,(struct sockaddr *)&address,sizeof(address))||transfer(fd,hello,136,1))return 5;
    if(!strcmp(mode,"stale")) {
        unsigned char byte;ssize_t n=read(fd,&byte,1);
        if(n!=0)return 6;close(fd);puts("stale-binding-closed");return 0;
    }
    if(transfer(fd,response,64,0))return 7;
    proof(tag,packet+96,"Hack relay auth v1",'S',packet,hello+104,response);
    if(!strcmp(mode,"wrong-key")) {
        if(equal(tag,response+32,32))return 8;
        proof(tag,packet+96,"Hack relay auth v1",'C',packet,hello+104,response);
        if(transfer(fd,tag,32,1))return 8;
        unsigned char byte;if(read(fd,&byte,1)!=0)return 8;
        close(fd);puts("wrong-key-refused");return 0;
    }
    if(!equal(tag,response+32,32))return 9;
    proof(tag,packet+96,"Hack relay auth v1",'C',packet,hello+104,response);
    if(transfer(fd,tag,32,1))return 10;
    proof(tag,packet+96,"Hack relay auth v1",'A',packet,hello+104,response);
    unsigned char accepted[32];if(transfer(fd,accepted,32,0)||!equal(tag,accepted,32))return 11;
    proof(c2s,packet+96,"Hack relay traffic v1",'C',packet,hello+104,response);
    proof(s2c,packet+96,"Hack relay traffic v1",'S',packet,hello+104,response);
    unsigned char data[16384],wire[16440];uint64_t seq=0;
    for(unsigned offset=0;offset<65536;offset+=sizeof(data)) {
        for(unsigned i=0;i<sizeof(data);i++)data[i]=(unsigned char)((offset+i)%251);
        size_t size=encode(wire,c2s,seq++,1,data,sizeof(data));
        if(!strcmp(mode,"tamper"))wire[24]^=1;
        if(transfer(fd,wire,size,1))return 12;
        if(!strcmp(mode,"replay")&&transfer(fd,wire,size,1))return 13;
        if(!strcmp(mode,"tamper")||!strcmp(mode,"replay")) {
            unsigned length;int kind=receive(fd,s2c,0,wire,&length);
            if(kind!=3||length)return 14;close(fd);puts("authenticated-reset");return 0;
        }
    }
    size_t size=encode(wire,c2s,seq,2,NULL,0);if(transfer(fd,wire,size,1))return 15;
    if(!strcmp(mode,"revoke")) {
        unsigned char byte;ssize_t n=read(fd,&byte,1);
        if(n!=0)return 16;close(fd);puts("revoked-closed");return 0;
    }
    unsigned total=0;seq=0;
    while(seq<65537) {
        unsigned length;int kind=receive(fd,s2c,seq++,wire,&length);
        if(kind==2&&!length&&total==65536){close(fd);puts("authenticated-echo-ok");return 0;}
        if(kind!=1||!length||total+length>65536)return 17;
        for(unsigned i=0;i<length;i++)if(wire[24+i]!=(unsigned char)((total+i)%251))return 18;
        total+=length;
    }
    return 19;
}
